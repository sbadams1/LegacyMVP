// lib/services/ai_brain_service.dart
//
// Single clean contract for talking to the "ai-brain" Supabase Edge Function.
//
// Goals:
// - Language-agnostic: DO NOT hard-code Thai/English/etc.
// - Prefer user profile locales when available; otherwise fall back to device locale.
// - Always send preferred_locale (L1) when possible; send target_locale (L2) when known.
// - Keep payload stable across refactors.
//
// Expected Edge response (minimum):
// {
//   reply_text: string | null,
//   mode: string,
//   preferred_locale: string | null,
//   target_locale: string | null,
//   learning_level: string | null,
//   conversation_id: string | null,
//   state_json: string | null,
//   end_session: boolean | null,
//   input_locale: string | null,
//   input_locale_confidence: number | null,
//   pronunciation_score: number | null,
//   pronunciation_score_line: string | null
// }

import 'dart:ui' show PlatformDispatcher;
import 'package:supabase_flutter/supabase_flutter.dart';

class AIBrainService {
  AIBrainService._internal();

  static final AIBrainService instance = AIBrainService._internal();

  final SupabaseClient _client = Supabase.instance.client;

  /// Calls the ai-brain Edge Function and returns a normalized map.
  ///
  /// Required:
  /// - [message] The user message for the turn (can be empty only when [endSession] is true)
  /// - [mode] "legacy" | "language_learning" | (future: avatar_*)
  ///
  /// Optional:
  /// - [preferredLocale] L1 locale (e.g., "en-US")
  /// - [targetLocale] L2 locale (e.g., "th-TH")
  /// - [learningLevel] e.g. "beginner"
  /// - [conversationId] existing conversation/session id
  /// - [stateJson] round-tripped pipeline state (JSON string)
  /// - [endSession] trigger post-processing
  Future<Map<String, dynamic>> askBrain({
    required String message,
    required String mode,
    String? preferredLocale,
    String? targetLocale,
    String? learningLevel,
    String? conversationId,
    String? stateJson,
    bool endSession = false,
  }) async {
    final user = _client.auth.currentUser;
    if (user == null) {
      throw Exception('User not logged in; cannot call ai-brain.');
    }

    // Resolve locales:
    // - If caller passes explicit locales, use them.
    // - Else try profile first (preferred_language / supported_languages).
    // - Else fall back to device locale.
    final resolved = await _resolveLocales(
      userId: user.id,
      preferredLocale: preferredLocale,
      targetLocale: targetLocale,
    );

    final body = <String, dynamic>{
      'user_id': user.id,
      'message_text': message,
      'mode': mode,
      'preferred_locale': resolved.preferredLocale,
      'target_locale': resolved.targetLocale,
      'learning_level': learningLevel,
      'conversation_id': conversationId,
      'state_json': stateJson,
      'end_session': endSession,
    }..removeWhere((key, value) => value == null);

    try {
      final response = await _client.functions.invoke(
        'ai-brain',
        body: body,
      );

      final data = (response.data is Map<String, dynamic>)
          ? (response.data as Map<String, dynamic>)
          : <String, dynamic>{};

      // Normalize reply text field name variations just in case.
      final text = (data['reply_text'] ??
              data['text'] ??
              data['message'] ??
              data['response'])
          as String?;

      return <String, dynamic>{
        'reply_text': text,
        'state_json': data['state_json'],
        'end_session': data['end_session'] == true,
        'end_session_summary': data['end_session_summary'],
        'insight_moment': data['insight_moment'],
        'pronunciation_score': data['pronunciation_score'],
        'pronunciation_score_line': data['pronunciation_score_line'],

        // pass-through metadata (useful for logging / UI)
        'mode': data['mode'],
        'preferred_locale': data['preferred_locale'] ?? resolved.preferredLocale,
        'target_locale': data['target_locale'] ?? resolved.targetLocale,
        'learning_level': data['learning_level'],
        'conversation_id': data['conversation_id'],
        'input_locale': data['input_locale'],
        'input_locale_confidence': data['input_locale_confidence'],
      };
    } catch (e) {
      // ignore: avoid_print
      print('⚠️ ai-brain error: $e');
      rethrow;
    }
  }

  /// Internal: resolve locales without hard-coding any language values.
  Future<_ResolvedLocales> _resolveLocales({
    required String userId,
    String? preferredLocale,
    String? targetLocale,
  }) async {
    String? pref = _cleanLocale(preferredLocale);
    String? targ = _cleanLocale(targetLocale);

    // 1) Try profile when either is missing.
    if (pref == null || targ == null) {
      try {
        final prof = await _client
            .from('profiles')
            .select('preferred_language, supported_languages')
            .eq('id', userId)
            .maybeSingle();

        if (prof != null && prof is Map<String, dynamic>) {
          final p = _cleanLocale(prof['preferred_language']);
          if (pref == null && p != null) pref = p;

          final supported = prof['supported_languages'];
          final List<String> supList = <String>[];
          if (supported is List) {
            for (final item in supported) {
              final c = _cleanLocale(item);
              if (c != null) supList.add(c);
            }
          }

          // If we still don't have a preferred locale, use the first supported.
          if (pref == null && supList.isNotEmpty) pref = supList.first;

          // Choose a target locale that is different from preferred.
          if (targ == null && supList.isNotEmpty) {
            targ = supList.firstWhere(
              (x) => pref == null || x != pref,
              orElse: () => supList.first,
            );
            if (targ == pref) {
              // If only one language in the profile, treat as no target.
              targ = null;
            }
          }
        }
      } catch (_) {
        // Profile lookup is best-effort; fall back to device.
      }
    }

    // 2) Fall back to device locale for preferred locale (L1)
    pref ??= _deviceLocaleTag();

    // Never coerce target into existence; null is allowed.
    if (targ != null && targ == pref) {
      targ = null;
    }

    return _ResolvedLocales(preferredLocale: pref, targetLocale: targ);
  }

  String _deviceLocaleTag() {
    try {
      final loc = PlatformDispatcher.instance.locale;
      // Locale.toLanguageTag exists for Dart's Locale.
      return loc.toLanguageTag();
    } catch (_) {
      // "und" is the standard BCP-47 tag for "undetermined".
      return 'und';
    }
  }

  String? _cleanLocale(Object? raw) {
    if (raw == null) return null;
    if (raw is String) {
      final v = raw.trim();
      if (v.isEmpty) return null;
      // Keep language-agnostic; do not map languages.
      return v.replaceAll('_', '-');
    }
    return null;
  }
}

class _ResolvedLocales {
  final String preferredLocale;
  final String? targetLocale;

  const _ResolvedLocales({
    required this.preferredLocale,
    required this.targetLocale,
  });
}
