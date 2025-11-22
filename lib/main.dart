// lib/main.dart

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'screens/startup_router.dart';
import 'package:legacy_mobile/screens/chat_screen.dart'; // <-- uses your pubspec name: legacy_mobile

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize Supabase
  //
  // IMPORTANT:
  // - Replace SUPABASE_URL and SUPABASE_ANON_KEY with your actual values
  //   from Supabase -> Settings -> API (use the new "Publishable" key here)
  //
  // - This anon/publishable key is SAFE for client-side use.
  //   Your Cloud Function uses the SECRET key (server-side) already.
  await Supabase.initialize(
    url: 'https://qhlnfgtnqtepwuwbloai.supabase.co', // your project URL
    anonKey: 'sb_publishable_LcG-1o1_QckDNDI0KDbo5Q_7nDgZC4o',
  );

  runApp(const LegacyMobileApp());
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
      // For now, start directly on the AI Brain Chat screen.
      // Later you can add routing, auth gates, etc.
      home: const StartupRouter(),
    );
  }
}
