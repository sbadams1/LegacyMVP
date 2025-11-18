// lib/services/ai_brain_service.dart
//
// Minimal AIBrainService wired to the Supabase Edge Function "ai-brain".
// Uses supabase_flutter. Exposes askBrain() for the UI to call.

import 'package:supabase_flutter/supabase_flutter.dart';

class AIBrainService {
  AIBrainService._internal();

  static final AIBrainService instance = AIBrainService._internal();

  final SupabaseClient _client = Supabase.instance.client;

  /// Ask the brain a question.
  ///
  /// [userId] should be the authenticated Supabase user's id.
  /// [message] is the user's natural language input.
  /// [parentId] is optional; you can use it later for threading.
  Future<String> askBrain({
    required String userId,
    required String message,
    String? parentId,
  }) async {
    try {
      final response = await _client.functions.invoke(
        'ai-brain',
        body: <String, dynamic>{
          'user_id': userId,
          'message': message,
          if (parentId != null) 'parent_id': parentId,
        },
      );

      final data = response.data;
      if (data is Map<String, dynamic>) {
        final reply = data['reply'] as String?;
        if (reply != null && reply.trim().isNotEmpty) {
          return reply;
        }
      }

      return 'Sorry, I did not receive a valid reply from the brain.';
    } catch (e) {
      // Basic error handling; you can improve logging as needed
      return 'Error talking to the brain: $e';
    }
  }
}
