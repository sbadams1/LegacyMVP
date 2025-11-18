import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart' show rootBundle;
import 'package:googleapis_auth/auth_io.dart';
import 'package:googleapis/speech/v1.dart';

// You will need to make sure this path is correct for your project structure.
const _serviceAccountAssetPath = 'assets/google_speech.json';
const _speechApiScope = 'https://www.googleapis.com/auth/cloud-platform';

/// A service class to handle transcription using the Google Cloud Speech-to-Text API.
class SpeechToTextService {
  final List<String> _scopes = [_speechApiScope];

  /// Loads the service account credentials from the asset file.
  Future<ServiceAccountCredentials> _loadCredentials() async {
    try {
      final jsonString = await rootBundle.loadString(_serviceAccountAssetPath);
      final jsonCredentials = json.decode(jsonString);
      return ServiceAccountCredentials.fromJson(jsonCredentials);
    } catch (e) {
      // It is crucial to handle this error as authentication is the first step.
      print('Error loading service account credentials: $e');
      throw Exception('Failed to load Google Cloud credentials. Check $_serviceAccountAssetPath');
    }
  }

  /// Transcribes a locally stored audio file using the Google Cloud Speech-to-Text API.
  ///
  /// The audio file should be a WAV or FLAC file, and the format must match
  /// the configuration (e.g., 16000Hz, mono).
  ///
  /// [audioFilePath] is the absolute path to the recorded audio file on the device.
  Future<String> transcribeAudio(String audioFilePath) async {
    // 1. Authenticate
    final credentials = await _loadCredentials();
    final client = await clientViaServiceAccount(credentials, _scopes);

    try {
      // 2. Initialize the Speech API client
      final speechApi = SpeechApi(client);

      // 3. Read the audio file bytes and encode to base64
      final audioFile = File(audioFilePath);
      if (!await audioFile.exists()) {
        throw Exception('Audio file not found at path: $audioFilePath');
      }
      final audioBytes = await audioFile.readAsBytes();
      final audioBase64 = base64Encode(audioBytes);

      // 4. Build the API request
      final request = RecognizeRequest(
        config: RecognitionConfig(
          // IMPORTANT: Update these settings to match the format used by the
          // 'record' or 'flutter_sound' package when recording.
          encoding: 'LINEAR16', // e.g., 'LINEAR16' for uncompressed WAV
          sampleRateHertz: 16000, // Common for mobile device recordings
          languageCode: 'en-US', // Change to your target language
          // You can add more config options here, like 'enableAutomaticPunctuation'
        ),
        audio: RecognitionAudio(
          content: audioBase64,
        ),
      );

      // 5. Call the API
      final response = await speechApi.speech.recognize(request);

      // 6. Process the response
      if (response.results != null && response.results!.isNotEmpty) {
        final result = response.results!.first;
        if (result.alternatives != null && result.alternatives!.isNotEmpty) {
          return result.alternatives!.first.transcript ?? 'Transcription failed.';
        }
      }

      return 'No recognizable speech found.';

    } catch (e) {
      print('Speech-to-Text API Error: $e');
      return 'Error during transcription: $e';
    } finally {
      // Ensure the HTTP client is closed
      client.close();
    }
  }
}

// --- Example Usage ---
// This class demonstrates how you would use the service in your UI/Logic.
class ExampleUsage {
  final _sttService = SpeechToTextService();

  Future<void> runTranscriptionDemo() async {
    // IMPORTANT: Replace this with the actual path to your recorded audio file.
    const recordedFilePath = '/data/user/0/com.your.app/app_flutter/temp_audio.wav';

    print('Starting transcription for: $recordedFilePath');

    try {
      final transcript = await _sttService.transcribeAudio(recordedFilePath);
      print('--- Transcription Result ---');
      print(transcript);
      print('----------------------------');
    } catch (e) {
      print('DEMO FAILED: $e');
    }
  }
}