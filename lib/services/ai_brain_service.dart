// lib/services/ai_brain_service.dart
//
// Central service for talking to the AI brain via Supabase Edge Functions
// and writing raw messages into the memory_raw table, plus triggering
// level-2 summaries in memory_summary and lifetime profiles in memory_profile.
//
// This version:
// - Keeps the original askBrain({ required String message }) API,
//   so existing UI code still works.
// - Fetches primary_language from donor_profile.
// - Sends primary_language to BOTH ai-brain and memory-summarize.

import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:uuid/uuid.dart';
import 'package:legacy_mobile/services/donor_profile_service.dart';

class AIBrainService {
  AIBrainService._internal()
      : _client = Supabase.instance.client,
        _conversationId = const Uuid().v4();

  static final AIBrainService instance = AIBrainService._internal();

  final SupabaseClient _client;

  /// One logical conversation id for this service lifetime.
  ///
  /// The same id is passed to:
  /// - ai-brain (for generating replies with context)
  /// - memory-summarize (for per-conversation summaries)
  ///
  /// If you want to explicitly start a brand-new interview in the UI,
  /// call [startNewConversation] before sending the next message.
  String _conversationId;

  String get conversationId => _conversationId;

  /// Reset the conversation id.
  ///
  /// Call this when the user taps "Start new interview" or similar.
  void startNewConversation() {
    _conversationId = const Uuid().v4();
  }

  /// Helper to get the user's primary language from donor_profile.
  ///
  /// Falls back to 'en-US' if no profile is found.
  Future<String> _getPrimaryLanguage() async {
    try {
      final profile =
          await DonorProfileService.instance.getCurrentUserProfile();
      if (profile != null && profile.primaryLanguage.isNotEmpty) {
        return profile.primaryLanguage;
      }
    } catch (e) {
      // ignore: avoid_print
      print('⚠️ Failed to load donor_profile for language: $e');
    }
    return 'en-US';
  }

  /// Ask the AI brain a question.
  ///
  /// Flow:
  /// 1. Ensure user is authenticated.
  /// 2. Resolve the user's primary_language from donor_profile.
  /// 3. Insert the user's message into memory_raw (source='user').
  /// 4. Call the `ai-brain` Edge Function with { user_id, message,
  ///    conversation_id, primary_language }.
  /// 5. Insert the AI's reply into memory_raw (source='assistant').
  /// 6. Trigger the `memory-summarize` Edge Function (non-blocking) to
  ///    update memory_summary and memory_profile for this user / conversation.
  /// 7. Return the AI's reply string.
  Future<String> askBrain({
    required String message,
  }) async {
    // 1) Ensure the user is signed in
    final user = _client.auth.currentUser;
    if (user == null) {
      throw Exception('Not signed in - cannot talk to AI brain.');
    }
    final userId = user.id;

    // 2) Get the donor's preferred primary language
    final primaryLanguage = await _getPrimaryLanguage();

    // 3) Log the user message into memory_raw (level 1 memory)
    try {
      await _client.from('memory_raw').insert({
        'user_id': userId,
        'source': 'user',
        'content': message,
        // Optional if you added a language_code column:
        // 'language_code': primaryLanguage,
        // Optional if your memory_raw has a conversation_id column:
        // 'conversation_id': _conversationId,
      });
    } catch (e) {
      // Don't block the main flow if logging fails
      // ignore: avoid_print
      print('⚠️ Failed to insert user message into memory_raw: $e');
    }

    // 4) Call the ai-brain Edge Function
    final response = await _client.functions.invoke(
      'ai-brain',
      body: {
        'user_id': userId,
        'message': message,
        'conversation_id': _conversationId,
        'primary_language': primaryLanguage,
      },
    );

    final raw = response.data;
    if (raw == null) {
      throw Exception('No data returned from ai-brain.');
    }

    Map<String, dynamic> data;

    if (raw is Map<String, dynamic>) {
      data = raw;
    } else if (raw is List && raw.isNotEmpty && raw.first is Map<String, dynamic>) {
      data = raw.first as Map<String, dynamic>;
    } else {
      // Fallback: wrap whatever came back
      data = {'reply': raw.toString()};
    }

    final reply = _extractReplyString(data);

    // 5) Log the AI reply into memory_raw
    try {
      await _client.from('memory_raw').insert({
        'user_id': userId,
        'source': 'assistant',
        'content': reply,
        // Optional:
        // 'language_code': primaryLanguage,
        // 'conversation_id': _conversationId,
      });
    } catch (e) {
      // Don't block the main flow if logging fails
      // ignore: avoid_print
      print('⚠️ Failed to insert AI reply into memory_raw: $e');
    }

    // 6) Trigger memory-summarize for this user + conversation.
    //
    //    This keeps memory_summary (per-conversation) and memory_profile
    //    (lifetime profile) up to date on the backend.
    try {
      await _client.functions.invoke(
        'memory-summarize',
        body: {
          'user_id': userId,
          'conversation_id': _conversationId,
          'primary_language': primaryLanguage,
        },
      );
    } catch (e) {
      // Do not block the main chat flow if summarization fails.
      // ignore: avoid_print
      print('⚠️ Failed to update memory_summary/profile: $e');
    }

    // 7) Return the AI's reply text to the caller (chat UI, etc.)
    return reply;
  }

  /// Helper to robustly extract a reply string from the edge function response.
  ///
  /// We try several common keys in priority order, and fall back to
  /// a JSON-ish stringified map if nothing obvious is found.
  String _extractReplyString(Map<String, dynamic>? data) {
    if (data == null) {
      return 'No reply from AI brain.';
    }

    final candidates = [
      'reply',
      'response',
      'message',
      'answer',
      'text',
    ];

    for (final key in candidates) {
      final value = data[key];
      if (value != null) {
        return value.toString();
      }
    }

    // Last resort: stringify the whole payload
    return data.toString();
  }
}
