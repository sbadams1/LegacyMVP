// lib/screens/terms_screen.dart

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../services/profile_service.dart';
import 'profile_setup_screen.dart';

class TermsScreen extends StatefulWidget {
  const TermsScreen({super.key});

  @override
  State<TermsScreen> createState() => _TermsScreenState();
}

class _TermsScreenState extends State<TermsScreen> {
  bool _tosChecked = false;
  bool _avatarChecked = false;
  bool _isSaving = false;

  final ProfileService _profileService = ProfileService();

  Future<void> _onAgree() async {
    if (!_tosChecked || _isSaving) return;

    setState(() {
      _isSaving = true;
    });

    try {
      // Mark TOS as accepted
      await _profileService.acceptTosForCurrentUser();

      // Save avatar consent flag
      final user = Supabase.instance.client.auth.currentUser;
      if (user != null) {
        await Supabase.instance.client.from('profiles').upsert({
          'id': user.id,
          'voice_avatar_consent': _avatarChecked,
        });
      }

      if (!mounted) return;

      // Go to profile setup (legal name + display name, birthdate, country)
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => const ProfileSetupScreen(),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to save. Please try again. ($e)'),
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Terms of Service'),
      ),
      body: SafeArea(
        child: Column(
          children: [
            // TOS text
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                child: Text(
                  // You can replace this with your real legal copy later
                  'Welcome to the Legacy app.\n\n'
                  'This app is designed to help you record and store personal memories, '
                  'stories, and reflections that may be shared with you or your loved ones '
                  'in the future.\n\n'
                  'By using this app, you agree that:\n'
                  '• You are responsible for the content you record and upload.\n'
                  '• You consent to storing your data securely in the cloud.\n'
                  '• This app is not a medical, legal, or financial service and does not '
                  'provide professional advice.\n\n'
                  'Please review these terms carefully. By checking the box and tapping '
                  '"I Agree", you accept these terms of service.',
                  style: theme.textTheme.bodyMedium,
                ),
              ),
            ),

            // Checkbox: TOS
            CheckboxListTile(
              title: const Text(
                'I have read and agree to the Terms of Service.',
              ),
              value: _tosChecked,
              onChanged: (value) {
                setState(() {
                  _tosChecked = value ?? false;
                });
              },
            ),

            // Checkbox: voice / avatar consent
            CheckboxListTile(
              title: const Text(
                'I consent to the app storing and using my voice and likeness to '
                'generate an AI avatar of me, and understand that this avatar may be '
                'accessible to my approved viewers (for example, selected family members).',
              ),
              subtitle: const Text(
                'You can change this later in Settings.',
                style: TextStyle(fontSize: 12),
              ),
              value: _avatarChecked,
              onChanged: (value) {
                setState(() {
                  _avatarChecked = value ?? false;
                });
              },
            ),

            // I Agree button
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 16.0,
                vertical: 16,
              ),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _tosChecked && !_isSaving ? _onAgree : null,
                  child: _isSaving
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('I Agree'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
