// lib/google_speech_auth.dart
import 'package:google_sign_in/google_sign_in.dart';
import 'package:googleapis/speech/v1.dart' as speech;
import 'package:http/http.dart' as http;
import 'package:googleapis_auth/auth_io.dart';

class GoogleSpeechAuth {
  // Only this scope is needed for Speech-to-Text
  static final _googleSignIn = GoogleSignIn(
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  );

  /// Returns an authenticated SpeechApi client using the user's own Google account
  static Future<speech.SpeechApi?> getApi() async {
    try {
      final account = await _googleSignIn.signInSilently() ?? await _googleSignIn.signIn();
      if (account == null) {
        print('Google Sign-In cancelled by user');
        return null;
      }

      final authHeaders = await account.authHeaders;
      final authenticatedClient = GoogleAuthClient(authHeaders);

      return speech.SpeechApi(authenticatedClient);
    } catch (e) {
      print('Google Sign-In or auth failed: $e');
      return null;
    }
  }
}

// Small helper class required by googleapis_auth
class GoogleAuthClient extends http.BaseClient {
  final Map<String, String> _headers;
  final http.Client _client = http.Client();

  GoogleAuthClient(this._headers);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    return _client.send(request..headers.addAll(_headers));
  }

  @override
  void close() => _client.close();
}