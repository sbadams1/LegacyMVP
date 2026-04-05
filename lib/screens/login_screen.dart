import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _pw = TextEditingController();
  bool _busy = false;
  String? _err;

  @override
  void dispose() {
    _email.dispose();
    _pw.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    final email = _email.text.trim();
    final password = _pw.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _err = 'Enter email + password.');
      return;
    }
    setState(() { _busy = true; _err = null; });
    try {
      await Supabase.instance.client.auth.signInWithPassword(
        email: email,
        password: password,
      );
    } catch (e) {
      setState(() => _err = 'Sign-in failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _signUp() async {
    final email = _email.text.trim();
    final password = _pw.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _err = 'Enter email + password.');
      return;
    }
    setState(() { _busy = true; _err = null; });
    try {
      await Supabase.instance.client.auth.signUp(
        email: email,
        password: password,
      );
      setState(() => _err = 'Sign-up succeeded. If email confirmation is enabled, check your inbox.');
    } catch (e) {
      setState(() => _err = 'Sign-up failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email')),
            const SizedBox(height: 12),
            TextField(controller: _pw, obscureText: true, decoration: const InputDecoration(labelText: 'Password')),
            const SizedBox(height: 16),
            if (_err != null) Text(_err!, style: const TextStyle(color: Colors.redAccent)),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton(
                    onPressed: _busy ? null : _signIn,
                    child: _busy
                      ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Sign in'),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton(onPressed: _busy ? null : _signUp, child: const Text('Create account')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
