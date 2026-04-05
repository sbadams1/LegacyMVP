// lib/services/ai_bridge.dart

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
      'ai-brain',
       body: {
        'message_text': prompt,
        'mode': 'legacy',
       },
     );

     final data = response.data;
     if (data is! Map<String, dynamic>) {
       throw Exception(
         'Unexpected response type for Gemini: ${data.runtimeType}',
       );
     }

     final error = data['error'];
     if (error != null) {
       throw Exception('Gemini error: $error');
     }

    final reply = (data['reply_text'] ?? data['reply']) as String?;
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
        'Unexpected response type for ElevenLabs TTS: ${data.runtimeType}',
      );
    }

    final error = data['error'];
    if (error != null) {
      throw Exception('ElevenLabs error: $error');
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

/// Call Google Speech-to-Text via the Supabase Edge Function `speech-to-text`.
/// Expects the function to respond with:
///   { "transcript": "<text>" } or { error, details, googleError }
///
/// IMPORTANT:
///   - `audioBase64` should be the base64 encoding of your recorded AAC file
///   - The edge function is configured with your original STT config:
///       encoding: 'MP3'
///       sampleRateHertz: 48000
///       enableAutomaticPunctuation: true
///
/// `primaryLanguage` should be a BCP-47 code such as:
///   - en-US
///   - th-TH
///   - es-ES
Future<String> callGoogleSpeech({
  required String audioBase64,
  String primaryLanguage = 'en-US',
  int sampleRateHz = 48000,
}) async {
  try {
    final response = await _supabase.functions.invoke(
      'speech-to-text',
      body: {
        'audio_base64': audioBase64,
        'sample_rate_hz': sampleRateHz,
        'primary_language': primaryLanguage,
      },
    );

    final data = response.data;
    if (data == null || data is! Map<String, dynamic>) {
      throw Exception(
        'Unexpected response type for speech-to-text: ${data.runtimeType}',
      );
    }

    // Function-level error (Google API failure, config, etc.)
    if (data['error'] != null) {
      final msg = data['error']?.toString() ?? 'Unknown STT error';
      final details = data['details']?.toString();
      final googleError = data['googleError']?.toString();
      // ignore: avoid_print
      print('Google STT error: $msg');
      if (details != null) {
        // ignore: avoid_print
        print('  details: $details');
      }
      if (googleError != null) {
        // ignore: avoid_print
        print('  googleError: $googleError');
      }
      throw Exception(msg);
    }

    final transcript = data['transcript'] as String? ?? '';
    if (transcript.trim().isEmpty) {
      throw Exception('Google Speech returned empty transcript.');
    }

    return transcript;
  } catch (e) {
    throw Exception('Failed to call Google Speech: $e');
  }
}
