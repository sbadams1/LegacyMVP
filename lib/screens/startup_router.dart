// lib/screens/startup_router.dart

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../services/profile_service.dart';
import 'onboarding_screen.dart';
import 'profile_setup_screen.dart';
import 'chat_screen.dart';

class StartupRouter extends StatefulWidget {
  const StartupRouter({super.key});

  @override
  State<StartupRouter> createState() => _StartupRouterState();
}

class _StartupRouterState extends State<StartupRouter> {
  final ProfileService _profileService = ProfileService();

  @override
  void initState() {
    super.initState();
    _decideStartScreen();
  }

  Future<void> _decideStartScreen() async {
    final client = Supabase.instance.client;

    try {
    // 1) Ensure we have *some* signed-in user (anonymous is fine).
    var user = client.auth.currentUser;

    if (user == null) {
      await client.auth.signInAnonymously();
      user = client.auth.currentUser;
    }

    if (!mounted) return;

    // If anonymous sign-in failed for any reason, show a clear message
    if (user == null) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => const Scaffold(
            body: Center(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: Text('Startup: still not signed in after anonymous sign-in.'),
              ),
            ),
          ),
        ),
      );
      return;
    }

    // 2) Continue with your existing profile gating
    final profile = await _profileService.loadCurrentProfile();

    if (!mounted) return;

    Widget target;

    if (profile == null || !profile.tosAccepted) {
      target = const OnboardingScreen();
    } else {
      final isProfileIncomplete =
          (profile.displayName == null ||
              profile.displayName!.trim().isEmpty ||
              profile.birthdate == null ||
              profile.countryRegion == null ||
              profile.countryRegion!.trim().isEmpty);

      target = isProfileIncomplete
          ? const ProfileSetupScreen()
          : const ChatScreen();
    }

    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => target),
    );
    } catch (e) {
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('Startup error')),
          body: Center(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Text('Startup failed: $e', textAlign: TextAlign.center),
            ),
          ),
        ),
      ),
    );
    }
  }

  @override
  Widget build(BuildContext context) {
    // Simple loading screen while we decide where to go
    return const Scaffold(
      body: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}
