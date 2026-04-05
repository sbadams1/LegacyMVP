import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'login_screen.dart';

class AuthGate extends StatelessWidget {
  final Widget authedChild;
  const AuthGate({super.key, required this.authedChild});

  @override
  Widget build(BuildContext context) {
    final client = Supabase.instance.client;

    return StreamBuilder<AuthState>(
      stream: client.auth.onAuthStateChange,
      builder: (context, snapshot) {
        final session = client.auth.currentSession;
        final user = client.auth.currentUser;
        if (session == null || user == null) return const LoginScreen();
        return authedChild;
      },
    );
  }
}
