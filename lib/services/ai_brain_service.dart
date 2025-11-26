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
//   learning_level     // e.g. "beginner"
// }
//
// Response shape (expected):
// { reply_text: string }

import 'package:supabase_flutter/supabase_flutter.dart';

class AIBrainService {
  AIBrainService._internal();

  static final AIBrainService instance = AIBrainService._internal();

  final SupabaseClient _client = Supabase.instance.client;

 Future<String> askBrain({
  required String message,
  required String mode,
  String? preferredLocale,
  String? targetLocale,
  String? learningLevel,
  String? conversationId,
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

    // Our Edge Function returns { reply_text: "..." } on success
    final text = (data['reply_text'] ??
            data['text'] ??
            data['message'] ??
            data['response']) as String?;
    if (text == null || text.trim().isEmpty) {
      throw Exception('ai-brain response missing reply_text/text field.');
    }

    return text.trim();

  } catch (e) {
    // ignore: avoid_print
    print('⚠️ ai-brain error: $e');
    rethrow;
  }
} 
}
