// lib/main.dart
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

// App routing
import 'screens/startup_router.dart';
import 'package:legacy_mobile/screens/chat_screen.dart';

// -----------------------------------------------------------------------------
// Supabase client-safe configuration
// - URL can be hardcoded (not secret)
// - Publishable (anon) key MUST be provided via --dart-define
// -----------------------------------------------------------------------------

const String SUPABASE_URL = 'https://qhlnfgtnqtepwuwbloai.supabase.co';

const String SB_PUBLISHABLE_KEY = String.fromEnvironment(
  'SB_PUBLISHABLE_KEY',
  defaultValue: '',
);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Make startup exceptions visible in console
  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.dumpErrorToConsole(details);
  };

  runZonedGuarded(() async {
    if (SB_PUBLISHABLE_KEY.isEmpty) {
      throw Exception(
        'Missing SB_PUBLISHABLE_KEY. '
        'Run with --dart-define=SB_PUBLISHABLE_KEY=YOUR_SUPABASE_ANON_KEY',
      );
    }

    await Supabase.initialize(
      url: SUPABASE_URL,
      anonKey: SB_PUBLISHABLE_KEY,
    );

    // Optional: print a JWT for debugging/admin tooling (e.g., backfill scripts).
    // This will print after a user signs in (or immediately if a session is restored).
    final supa = Supabase.instance.client;
    final session = supa.auth.currentSession;
    if (session?.accessToken != null && session!.accessToken.isNotEmpty) {
      // ignore: avoid_print
      print('ACCESS_TOKEN_JWT=${session.accessToken}');
    }
    supa.auth.onAuthStateChange.listen((data) {
      final s = data.session;
      if (s?.accessToken != null && s!.accessToken.isNotEmpty) {
        // ignore: avoid_print
        print('ACCESS_TOKEN_JWT=${s.accessToken}');
      }
    });


    runApp(const LegacyMobileApp());
  }, (Object error, StackTrace stack) {
    // ignore: avoid_print
    print('❌ Unhandled startup error: $error');
    // ignore: avoid_print
    print(stack);
  });
}


class LegacyMobileApp extends StatelessWidget {
  const LegacyMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Legacy',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),

      // Default entrypoint
      home: const AuthDiagnosticsShell(child: StartupRouter()),

      // TEMP DIAGNOSTIC (bypass router if needed):
      // home: const ChatScreen(),
    );
  }
}

class AuthDiagnosticsShell extends StatefulWidget {
  final Widget child;
  const AuthDiagnosticsShell({super.key, required this.child});

  @override
  State<AuthDiagnosticsShell> createState() => _AuthDiagnosticsShellState();
}

class _AuthDiagnosticsShellState extends State<AuthDiagnosticsShell> {
  bool _hasSignedInBefore = false;

  @override
  void initState() {
    super.initState();
    _initFlag();
    _listenAuth();
  }

  Future<void> _initFlag() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() => _hasSignedInBefore = prefs.getBool('hasSignedInBefore') ?? false);
  }

  void _listenAuth() {
    Supabase.instance.client.auth.onAuthStateChange.listen((data) async {
      final event = data.event;
      if (event == AuthChangeEvent.signedIn) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setBool('hasSignedInBefore', true);
        if (mounted) setState(() => _hasSignedInBefore = true);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final user = Supabase.instance.client.auth.currentUser;

    // If the user previously signed in, but we now have no session/user, warn loudly.
    // This prevents “silent reset” confusion.
    if (_hasSignedInBefore && user == null) {
      return Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              MaterialBanner(
                content: const Text(
                  'You appear to be signed out unexpectedly (no Supabase session found). '
                  'This is usually caused by missing/incorrect SB_PUBLISHABLE_KEY, wrong project URL, '
                  'cleared app storage, or an auth refresh failure.',
                ),
                actions: [
                  TextButton(
                    onPressed: () async {
                      // Best-effort: forces rebuild; user can also re-login.
                      setState(() {});
                    },
                    child: const Text('Dismiss'),
                  ),
                ],
              ),
              Expanded(child: widget.child),
            ],
          ),
        ),
      );
    }

    return widget.child;
  }
}
