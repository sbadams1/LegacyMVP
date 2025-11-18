// lib/services/elevenlabs_service.dart
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;

class ElevenLabsService {
  static const String apiKey = 'sk_d4a2077d94bae85ae6c666867186f64715eaa577baf64e70'; // ← Get from https://elevenlabs.io
  static const String baseUrl = 'https://api.elevenlabs.io/v1';

  static Future<String?> createVoice(String name, List<String> audioPaths) async {
    final uri = Uri.parse('$baseUrl/voices/add');
    final request = http.MultipartRequest('POST', uri)
      ..headers['xi-api-key'] = apiKey
      ..fields['name'] = name
      ..fields['description'] = 'Trained on my legacy recordings';

    for (final path in audioPaths) {
      if (await File(path).exists()) {
        request.files.add(await http.MultipartFile.fromPath('files', path));
      }
    }

    final response = await request.send();
    if (response.statusCode == 200) {
      final json = jsonDecode(await response.stream.bytesToString());
      return json['voice_id'];
    } else {
      print('ElevenLabs Error: ${response.statusCode}');
      return null;
    }
  }

  static Future<String?> generateSpeech(String voiceId, String text) async {
    final response = await http.post(
      Uri.parse('$baseUrl/text-to-speech/$voiceId'),
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'text': text,
        'model_id': 'eleven_monolingual_v1',
        'voice_settings': {'stability': 0.5, 'similarity_boost': 0.8}
      }),
    );

    if (response.statusCode == 200) {
      final file = File('${(await getTemporaryDirectory()).path}/ai_voice.mp3');
      await file.writeAsBytes(response.bodyBytes);
      return file.path;
    }
    return null;
  }
}