import 'dart:convert';
import 'package:http/http.dart' as http;

class BrainService {
  final String baseUrl =
      'https://us-central1-legacymvp-477713.cloudfunctions.net/brain';

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
    required String userId,
    required String message,
    String? sessionId,
    String? mediaType,
    String? mediaUrl,
  }) async {
    final uri = Uri.parse(baseUrl);

    final Map<String, dynamic> payload = {
      'userId': userId,
      'message': message,
    };

    // Optional fields (backend can use these to populate session_id, media_type, etc.)
    if (sessionId != null && sessionId.isNotEmpty) {
      payload['sessionId'] = sessionId;
    }
    if (mediaType != null && mediaType.isNotEmpty) {
      payload['mediaType'] = mediaType;
    }
    if (mediaUrl != null && mediaUrl.isNotEmpty) {
      payload['mediaUrl'] = mediaUrl;
    }

    final response = await http.post(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(payload),
    );

    if (response.statusCode != 200) {
      throw Exception(
          'Brain error: ${response.statusCode} ${response.body}');
    }

    final data = jsonDecode(response.body) as Map<String, dynamic>;
    final reply = data['reply'];

    if (reply is String) {
      return reply;
    } else {
      throw Exception('Brain error: unexpected response format');
    }
  }
}
