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
    final user = client.auth.currentUser;

    Widget target;

    if (user == null) {
      // Fallback: if you later add a proper AuthScreen, route there instead.
      // For now, keep existing behavior: go straight to ChatScreen.
      target = const ChatScreen();
    } else {
      final profile = await _profileService.loadCurrentProfile();

      if (!mounted) return;

      if (profile == null || !profile.tosAccepted) {
        // No TOS accepted → start onboarding (which leads into TOS → ProfileSetup)
        target = const OnboardingScreen();
      } else {
        final isProfileIncomplete =
            (profile.displayName == null ||
                profile.displayName!.trim().isEmpty ||
                profile.birthdate == null ||
                profile.countryRegion == null ||
                profile.countryRegion!.trim().isEmpty);

        if (isProfileIncomplete) {
          target = const ProfileSetupScreen();
        } else {
          target = const ChatScreen();
        }
      }
    }

    if (!mounted) return;

    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => target),
    );
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
