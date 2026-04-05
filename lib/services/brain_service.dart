import 'package:supabase_flutter/supabase_flutter.dart';

class BrainService {
  final SupabaseClient _client = Supabase.instance.client;

  /// Call the Brain (Cloud Function) / Gemini pipeline.
  ///
  /// Required:
  /// - [userId]: who is speaking
  /// - [message]: the text content
  ///
  /// Optional:
  /// - [sessionId]: stable id for a conversation (so backend can group messages)
  /// - [mediaType]: 'audio', 'image', 'video', etc. (for future use)
  /// - [mediaUrl]: public URL to the media, if any
  Future<String> callBrain({
    required String userId, // kept for backward compatibility; JWT is source of truth now
    required String message,
    String? sessionId,
    String? mediaType,
    String? mediaUrl,
  }) async {

    // Auth must be present; Edge Functions rely on JWT.
    final session = _client.auth.currentSession ?? (await _client.auth.getSession()).data.session;
    if (session?.user == null) {
      throw Exception('Not signed in.');
    }

    // IMPORTANT: do not send user_id from the client; server derives from JWT.
    final Map<String, dynamic> payload = {
      'message_text': message,
      'mode': 'legacy',
    };
    if (sessionId != null && sessionId.isNotEmpty) payload['conversation_id'] = sessionId;
    if (mediaType != null && mediaType.isNotEmpty) payload['media_type'] = mediaType;
    if (mediaUrl != null && mediaUrl.isNotEmpty) payload['media_url'] = mediaUrl;

    final res = await _client.functions.invoke('ai-brain', body: payload);
    final data = res.data;
    if (data is! Map) {
      throw Exception('Brain error: ai-brain returned non-object: ${data.runtimeType}');
    }
    if (data['error'] != null) {
      throw Exception('Brain error: ${data['error']}');
    }

    final reply = (data['reply_text'] ?? data['reply']) as String?;
    if (reply == null || reply.trim().isEmpty) {
      throw Exception('Brain error: empty reply');
    }
    return reply;
   }
 }
