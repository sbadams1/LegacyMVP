// lib/services/ai_brain_service.dart
//
// Central service for talking to the AI brain via Supabase Edge Function
// and writing raw messages into the memory_raw table.

import 'package:supabase_flutter/supabase_flutter.dart';

class AIBrainService {
  AIBrainService._internal();

  static final AIBrainService instance = AIBrainService._internal();

  final SupabaseClient _client = Supabase.instance.client;

  /// Ask the AI brain a question.
  ///
  /// - Writes the user message to memory_raw (source: 'user').
  /// - Calls the 'ai-brain' Edge Function to get a reply
  ///   (which expects user_id and message in the body).
  /// - Writes the AI reply to memory_raw (source: 'ai_reply').
  /// - Returns the reply text.
  Future<String> askBrain({required String message}) async {
    final user = _client.auth.currentUser;
    final userId = user?.id;

    if (userId == null) {
      throw Exception('User is not authenticated.');
    }

    // 1) Store the user message as a raw memory
    try {
      await _client.from('memory_raw').insert({
        'user_id': userId,
        'source': 'user',
        'content': message,
        'context': {
          'origin': 'chat_screen',
          'channel': 'text_or_stt',
        },
      });
    } catch (e) {
      // Don't block the chat if logging fails, just log it
      // ignore: avoid_print
      print('⚠️ Failed to insert user memory_raw: $e');
    }

    // 2) Call the AI brain function
    //
    // Your Edge Function currently expects both user_id and message
    // in the JSON body, otherwise it returns:
    //   { error: "user_id and message are required" }
    final response = await _client.functions.invoke(
      'ai-brain',
      body: {
        'user_id': userId,
        'message': message,
      },
    );

    if (response.status != 200) {
      throw Exception(
        'AI brain HTTP ${response.status}: ${response.data}',
      );
    }

    final data = response.data;

    // Flexible parsing: allow either { reply: "..." } or raw string
    String reply;
    if (data is Map && data['reply'] is String) {
      reply = data['reply'] as String;
    } else if (data is String) {
      reply = data;
    } else {
      reply = data.toString();
    }

    // 3) Store the AI reply as a raw memory
    try {
      await _client.from('memory_raw').insert({
        'user_id': userId,
        'source': 'ai_reply',
        'content': reply,
        'context': {
          'origin': 'ai_brain_reply',
        },
      });
    } catch (e) {
      // Again, don't block UX if logging fails
      // ignore: avoid_print
      print('⚠️ Failed to insert AI memory_raw: $e');
    }

    return reply;
  }
}
