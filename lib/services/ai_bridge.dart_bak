import 'dart:convert';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Convenience handle to the Supabase client.
final SupabaseClient _supabase = Supabase.instance.client;

/// Call Gemini via the Supabase Edge Function `legacy-ai`.
/// Expects the function to respond with:
///   { "reply": "<text>" }
Future<String> callGemini(String prompt) async {
  try {
    final response = await _supabase.functions.invoke(
      'legacy-ai',
      body: {
        'provider': 'gemini',
        'prompt': prompt,
      },
    );

    final data = response.data;
    if (data is! Map<String, dynamic>) {
      throw Exception(
        'Unexpected response type for Gemini: ${data.runtimeType}',
      );
    }

    if (data['error'] != null) {
      throw Exception('Gemini error: ${data['error']}');
    }

    final reply = data['reply'] as String?;
    if (reply == null || reply.isEmpty) {
      throw Exception('Gemini returned empty reply');
    }

    return reply;
  } catch (e) {
    throw Exception('Failed to call Gemini: $e');
  }
}

/// Call ElevenLabs TTS via the Supabase Edge Function `legacy-ai`.
/// Expects the function to respond with:
///   { "audioBase64": "<base64 mp3>" }
Future<String> callElevenLabsTts({
  required String text,
  required String voiceId,
}) async {
  try {
    final response = await _supabase.functions.invoke(
      'legacy-ai',
      body: {
        'provider': 'elevenlabs',
        'text': text,
        'voiceId': voiceId,
      },
    );

    final data = response.data;
    if (data is! Map<String, dynamic>) {
      throw Exception(
        'Unexpected response type for ElevenLabs: ${data.runtimeType}',
      );
    }

    if (data['error'] != null) {
      throw Exception('ElevenLabs error: ${data['error']}');
    }

    final audioBase64 = data['audioBase64'] as String?;
    if (audioBase64 == null || audioBase64.isEmpty) {
      throw Exception('ElevenLabs returned empty audioBase64');
    }

    return audioBase64;
  } catch (e) {
    throw Exception('Failed to call ElevenLabs TTS: $e');
  }
}

/// Call Google Speech-to-Text via the Supabase Edge Function `legacy-ai`.
/// Expects the function to respond with:
///   { "transcript": "<text>", "dbError": "<optional error message>" }
///
/// IMPORTANT:
///   - `audioBase64` should be the base64 encoding of your recorded AAC file
///   - The edge function is configured with your original STT config:
///       encoding: 'MP3'
///       sampleRateHertz: 48000
///       languageCode: 'en-US'
///       enableAutomaticPunctuation: true
Future<String> callGoogleSpeech({
  required String audioBase64,
  String languageCode = 'en-US',
}) async {
  try {
    final response = await _supabase.functions.invoke(
      'legacy-ai',
      body: {
        'provider': 'google-speech',
        'audioBase64': audioBase64,
        'languageCode': languageCode,
      },
    );

    final data = response.data;
    if (data is! Map<String, dynamic>) {
      throw Exception(
        'Unexpected response type for Google Speech: ${data.runtimeType}',
      );
    }

    // Hard failure from the function (e.g., Google API error)
    if (data['error'] != null) {
      throw Exception('Google Speech error: ${data['error']}');
    }

    final transcript = data['transcript'] as String?;
    if (transcript == null || transcript.isEmpty) {
      throw Exception('Google Speech returned empty transcript');
    }

    // Soft failure: STT worked but DB insert failed.
    final dbError = data['dbError'];
    if (dbError != null && dbError.toString().isNotEmpty) {
      // This will show up in your console / logcat
      // so we can see exactly why legacy_audio insert failed
      // (missing column, table name, RLS, etc.)
      // ignore: avoid_print
      print('legacy_audio insert error: $dbError');
    }

    return transcript;
  } catch (e) {
    throw Exception('Failed to call Google Speech: $e');
  }
}
