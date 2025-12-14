// lib/services/ai_brain_service.dart
//
// Single clean contract for talking to the "ai-brain" Supabase Edge Function.
//
// Payload shape:
// {
//   user_id,
//   conversation_id,
//   message_text,
//   mode,              // "legacy" | "language_learning" | (future: avatar_*)
//   preferred_locale,  // L1 (e.g. "en-US")
//   target_locale,     // L2 (e.g. "th-TH")
//   learning_level,    // e.g. "beginner"
//   state_json         // optional JSON string (lesson / legacy state)
// }
//
// Response shape (expected):
// {
//   reply_text: string,
//   mode: string,
//   preferred_locale: string,
//   target_locale: string | null,
//   learning_level: string | null,
//   conversation_id: string,
//   state_json: string | null
// }

import 'package:supabase_flutter/supabase_flutter.dart';

class AIBrainService {
  AIBrainService._internal();

  static final AIBrainService instance = AIBrainService._internal();

  final SupabaseClient _client = Supabase.instance.client;

  /// Call the ai-brain Edge Function.
  ///
  /// Returns a map with at least:
  ///   {
  ///     'text': String,        // the reply text to display/speak
  ///     'state_json': String?  // updated lesson/legacy state (if any)
  ///   }
  Future<Map<String, dynamic>> askBrain({
    required String message,
    required String mode,
    String? preferredLocale,
    String? targetLocale,
    String? learningLevel,
    String? conversationId,
    String? stateJson,
  }) async {
    final user = _client.auth.currentUser;
    if (user == null) {
      throw Exception('User not logged in; cannot call ai-brain.');
    }

    try {
      final body = <String, dynamic>{
        'user_id': user.id,
        // Edge Function expects "message_text", not "message"
        'message_text': message,
        'mode': mode, // "legacy" | "language_learning"

        // language context (all optional)
        'preferred_locale': preferredLocale,
        'target_locale': targetLocale,
        'learning_level': learningLevel,

        // future-proofing; can be null
        'conversation_id': conversationId,

        // round-tripped state for legacy / language lessons
        'state_json': stateJson,
      }..removeWhere((key, value) => value == null);

      final response = await _client.functions.invoke(
        'ai-brain',
        body: body,
      );

      // Extra logging so you actually see what's happening
      // ignore: avoid_print
      print('ai-brain response data: ${response.data}');

      if (response.data == null) {
        throw Exception('ai-brain returned no data.');
      }

      final data = response.data as Map<String, dynamic>;

      final text = (data['reply_text'] ??
              data['text'] ??
              data['message'] ??
              data['response']) as String?;
      if (text == null || text.trim().isEmpty) {
        throw Exception('ai-brain response missing reply_text/text field.');
      }

      final state = data['state_json'];

      return <String, dynamic>{
        'text': text.trim(),
        'state_json': state is String ? state : null,
        // pass-through metadata (optional for now, but handy if we need it)
        'mode': data['mode'],
        'preferred_locale': data['preferred_locale'],
        'target_locale': data['target_locale'],
        'learning_level': data['learning_level'],
        'conversation_id': data['conversation_id'],
      };
    } catch (e) {
      // ignore: avoid_print
      print('⚠️ ai-brain error: $e');
      rethrow;
    }
  }
}
