// lib/screens/chat_screen.dart
//
// Chat UI for the Legacy app:
//
// - Text → Gemini via AIBrainService (Supabase Edge Function "ai-brain")
// - Audio:
//     Record (AAC) → Supabase "speech-to-text" → transcript
//     Transcript → same _sendMessage() pipeline → Gemini
// - TTS:
//     Tap speaker on an AI message → Supabase "google-tts" → play MP3 in-app
//
// No Google secrets in-app; all keys live in Supabase.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:flutter_sound/flutter_sound.dart';

import '../services/ai_brain_service.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final TextEditingController _textController = TextEditingController();
  final List<_ChatMessage> _messages = <_ChatMessage>[];

  bool _isSending = false;

  // Audio recording / playback (user recordings)
  final FlutterSoundRecorder _audioRecorder = FlutterSoundRecorder();
  final FlutterSoundPlayer _audioPlayer = FlutterSoundPlayer();
  bool _isRecorderInitialized = false;
  bool _isPlayerInitialized = false;
  bool _isRecording = false;
  bool _isPlaying = false;
  String? _audioPath;

  // TTS player for AI replies
  final FlutterSoundPlayer _ttsPlayer = FlutterSoundPlayer();
  bool _isTtsInitialized = false;
  bool _isTtsPlaying = false;

  SupabaseClient get _supabase => Supabase.instance.client;

  @override
  void initState() {
    super.initState();
    _initAudio();
  }

  Future<void> _initAudio() async {
    // Microphone permission for recording
    final status = await Permission.microphone.request();
    if (!status.isGranted) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 4),
          content: Text('Microphone permission is required to record audio.'),
        ),
      );
      return;
    }

    await _audioRecorder.openRecorder();
    _isRecorderInitialized = true;

    await _audioPlayer.openPlayer();
    _isPlayerInitialized = true;

    await _ttsPlayer.openPlayer();
    _isTtsInitialized = true;
  }

  @override
  void dispose() {
    _textController.dispose();

    if (_isRecording) {
      _audioRecorder.stopRecorder();
    }
    if (_isPlaying) {
      _audioPlayer.stopPlayer();
    }
    if (_isTtsPlaying) {
      _ttsPlayer.stopPlayer();
    }

    _audioRecorder.closeRecorder();
    _audioPlayer.closePlayer();
    _ttsPlayer.closePlayer();

    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Core brain messaging (text + transcripts)
  // ---------------------------------------------------------------------------

  /// Send a message to the AI brain.
  ///
  /// If [presetText] is provided, that text is used instead of the
  /// TextField contents (used for quick prompts & STT transcripts).
  Future<void> _sendMessage({String? presetText}) async {
    if (_isSending) return;

    final text = presetText ?? _textController.text.trim();
    if (text.isEmpty) return;

    setState(() {
      _isSending = true;
      _messages.add(
        _ChatMessage(
          text: text,
          isUser: true,
          createdAt: DateTime.now(),
        ),
      );
      if (presetText == null) {
        _textController.clear();
      }
    });

    try {
      final reply = await AIBrainService.instance.askBrain(
        message: text,
      );

      if (!mounted) return;
      setState(() {
        _messages.add(
          _ChatMessage(
            text: reply,
            isUser: false,
            createdAt: DateTime.now(),
          ),
        );
      });
    } catch (e, st) {
      debugPrint('❌ Error talking to AI brain: $e\n$st');
      if (!mounted) return;
      setState(() {
        _messages.add(
          _ChatMessage(
            text: 'Error talking to the brain: $e',
            isUser: false,
            createdAt: DateTime.now(),
          ),
        );
      });
    } finally {
      if (!mounted) return;
      setState(() {
        _isSending = false;
      });
    }
  }

  void _onQuickPromptTapped(String prompt) {
    _sendMessage(presetText: prompt);
  }

  // ---------------------------------------------------------------------------
  // Audio recording + STT
  // ---------------------------------------------------------------------------

  void _onMicPressed() async {
    if (_isRecording) {
      await _stopRecordingAndTranscribe();
    } else {
      await _startRecording();
    }
  }

  Future<void> _startRecording() async {
    try {
      if (!_isRecorderInitialized) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 4),
            content: Text('Recorder is not initialized yet.'),
          ),
        );
        return;
      }

      var status = await Permission.microphone.status;
      if (!status.isGranted) {
        status = await Permission.microphone.request();
        if (!status.isGranted) {
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              duration: Duration(seconds: 4),
              content:
                  Text('Microphone permission is required to record audio.'),
            ),
          );
          return;
        }
      }

      final dir = await getTemporaryDirectory();
      _audioPath =
          '${dir.path}/recording_${DateTime.now().millisecondsSinceEpoch}.aac';

      await _audioRecorder.startRecorder(
        toFile: _audioPath,
        codec: Codec.aacADTS, // ✅ your known-good format
      );

      setState(() {
        _isRecording = true;
      });

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 2),
          content: Text('Recording your voice... Tap the mic again to stop.'),
        ),
      );
    } catch (e, st) {
      debugPrint('❌ Error starting recording: $e\n$st');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text('Error starting recording: $e'),
        ),
      );
    }
  }

  Future<void> _stopRecordingAndTranscribe() async {
    try {
      if (!_isRecorderInitialized) return;

      final path = await _audioRecorder.stopRecorder();
      setState(() {
        _isRecording = false;
        _audioPath = path;
      });

      debugPrint('🎙️ Recording stopped. Path: $path');

      if (path == null) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 4),
            content: Text('No audio captured.'),
          ),
        );
        return;
      }

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 2),
          content: Text('Transcribing your recording...'),
        ),
      );

      final transcript = await _transcribeViaSupabase(path);

      if (!mounted) return;

      if (transcript == null || transcript.trim().isEmpty) {
        debugPrint('⚠️ No transcript returned from STT.');
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 4),
            content: Text('No speech recognized from the recording.'),
          ),
        );
        return;
      }

      debugPrint('✅ Transcript from STT: $transcript');

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 2),
          content: Text('Transcript ready, sending to AI brain...'),
        ),
      );

      // Use the transcript as the message text and send it to Gemini
      await _sendMessage(presetText: transcript);
    } catch (e, st) {
      debugPrint('❌ Error stopping or transcribing: $e\n$st');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text('Error stopping or transcribing: $e'),
        ),
      );
    }
  }

  Future<String?> _transcribeViaSupabase(String filePath) async {
    try {
      final bytes = await File(filePath).readAsBytes();
      final b64 = base64Encode(bytes);

      debugPrint('📤 Sending audio to STT: ${bytes.length} bytes');

      final response = await _supabase.functions.invoke(
        'speech-to-text',
        body: {
          'audio_base64': b64,
          'sample_rate_hz': 48000,
        },
      );

      debugPrint('📥 STT response status: ${response.status}');
      debugPrint('📥 STT response data: ${response.data}');

      final data = response.data;
      if (data == null) {
        debugPrint('⚠️ STT response data is null.');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              duration: const Duration(seconds: 5),
              content: Text(
                'STT returned no data (status ${response.status}). '
                'Check Supabase logs for speech-to-text.',
              ),
            ),
          );
        }
        return null;
      }

      if (data is Map<String, dynamic>) {
        if (data['error'] != null) {
          final message = data['error']?.toString() ?? 'Unknown STT error';
          final details = data['details']?.toString();
          final googleError = data['googleError']?.toString();

          debugPrint('❌ STT error: $message');
          if (details != null) debugPrint('   details: $details');
          if (googleError != null) debugPrint('   googleError: $googleError');

          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                duration: const Duration(seconds: 6),
                content: Text(
                  [
                    message,
                    if (details != null) details,
                    if (googleError != null) googleError,
                  ].join('\n'),
                ),
              ),
            );
          }
          return null;
        }

        final transcript = data['transcript'] as String?;
        return transcript;
      }

      debugPrint('⚠️ Unexpected STT data type: ${data.runtimeType}');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            duration: const Duration(seconds: 5),
            content: Text(
              'Unexpected STT response type: ${data.runtimeType}\n$data',
            ),
          ),
        );
      }

      return null;
    } catch (e, st) {
      debugPrint('❌ STT function error: $e\n$st');
      if (!mounted) return null;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 6),
          content: Text('STT function error: $e'),
        ),
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Local playback (user recording)
  // ---------------------------------------------------------------------------

  Future<void> _onPlayAudioPressed() async {
    if (!_isPlayerInitialized) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 4),
          content: Text('Audio player is not initialized.'),
        ),
      );
      return;
    }

    final path = _audioPath;
    if (path == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 4),
          content: Text('No recording available to play.'),
        ),
      );
      return;
    }

    try {
      if (_isPlaying) {
        await _audioPlayer.stopPlayer();
        setState(() {
          _isPlaying = false;
        });
        return;
      }

      await _audioPlayer.startPlayer(
        fromURI: path,
        codec: Codec.aacADTS,
        whenFinished: () {
          if (mounted) {
            setState(() {
              _isPlaying = false;
            });
          }
        },
      );

      setState(() {
        _isPlaying = true;
      });
    } catch (e, st) {
      debugPrint('❌ Error playing audio: $e\n$st');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text('Error playing audio: $e'),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // TTS: speak AI replies
  // ---------------------------------------------------------------------------

  Future<void> _speakText(String text) async {
    if (!_isTtsInitialized) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          duration: Duration(seconds: 4),
          content: Text('TTS player is not initialized yet.'),
        ),
      );
      return;
    }

    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    try {
      if (_isTtsPlaying) {
        await _ttsPlayer.stopPlayer();
        setState(() {
          _isTtsPlaying = false;
        });
      }

      final response = await _supabase.functions.invoke(
        'google-tts',
        body: {
          'text': trimmed,
          'languageCode': 'en-US',
          'speakingRate': 1.0,
        },
      );

      debugPrint('🔊 TTS response status: ${response.status}');
      debugPrint('🔊 TTS response data: ${response.data}');

      final data = response.data;
      if (data == null || data is! Map) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 4),
            content: Text('Unexpected TTS response.'),
          ),
        );
        return;
      }

      if (data['error'] != null) {
        final msg = data['error']?.toString() ?? 'TTS error';
        final details = data['details']?.toString();
        debugPrint('❌ TTS error: $msg $details');
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            duration: const Duration(seconds: 5),
            content: Text('$msg\n${details ?? ''}'),
          ),
        );
        return;
      }

      final audioB64 = data['audioContent'] as String?;
      if (audioB64 == null) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 4),
            content: Text('No audioContent from TTS.'),
          ),
        );
        return;
      }

      final Uint8List bytes = base64Decode(audioB64);

      await _ttsPlayer.startPlayer(
        fromDataBuffer: bytes,
        codec: Codec.mp3,
        whenFinished: () {
          if (mounted) {
            setState(() {
              _isTtsPlaying = false;
            });
          }
        },
      );

      setState(() {
        _isTtsPlaying = true;
      });
    } catch (e, st) {
      debugPrint('❌ TTS error: $e\n$st');
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 5),
          content: Text('Error playing TTS audio: $e'),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Legacy AI Brain'),
        ),
        body: Column(
          children: <Widget>[
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.all(16),
                reverse: false,
                itemCount: _messages.length,
                itemBuilder: (context, index) {
                  final msg = _messages[index];
                  return _ChatBubble(
                    message: msg,
                    onSpeak: msg.isUser ? null : () => _speakText(msg.text),
                  );
                },
              ),
            ),
            const Divider(height: 1),
            _buildQuickPromptsRow(),
            _buildInputArea(),
          ],
        ),
      ),
    );
  }

  Widget _buildQuickPromptsRow() {
    final prompts = [
      'What’s on your mind today?',
      'Continue my legacy interview.',
      'Tell me a story from my childhood.',
      'Vent about something that bothered me recently.',
    ];

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Wrap(
          spacing: 8,
          runSpacing: 4,
          children: prompts
              .map(
                (prompt) => ActionChip(
                  label: Text(
                    prompt,
                    style: const TextStyle(fontSize: 12),
                  ),
                  onPressed: () => _onQuickPromptTapped(prompt),
                ),
              )
              .toList(),
        ),
      ),
    );
  }

  Widget _buildInputArea() {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.all(8.0),
        child: Row(
          children: <Widget>[
            IconButton(
              icon: Icon(
                _isRecording ? Icons.stop : Icons.mic,
                color: _isRecording ? Colors.red : null,
              ),
              onPressed: _onMicPressed,
              tooltip: _isRecording
                  ? 'Stop recording and send to AI'
                  : 'Record a voice note for STT',
            ),
            IconButton(
              icon: Icon(
                _isPlaying ? Icons.stop_circle : Icons.play_arrow,
              ),
              onPressed: _onPlayAudioPressed,
              tooltip: _isPlaying
                  ? 'Stop playing your last recording'
                  : 'Play your last recording',
            ),
            Expanded(
              child: TextField(
                controller: _textController,
                decoration: const InputDecoration.collapsed(
                  hintText: 'Type a message...',
                ),
                minLines: 1,
                maxLines: 4,
              ),
            ),
            IconButton(
              icon: _isSending
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
              onPressed: _isSending ? null : () => _sendMessage(),
            ),
          ],
        ),
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// Message model + bubble widget
// -----------------------------------------------------------------------------

class _ChatMessage {
  final String text;
  final bool isUser;
  final DateTime createdAt;

  _ChatMessage({
    required this.text,
    required this.isUser,
    required this.createdAt,
  });
}

class _ChatBubble extends StatelessWidget {
  final _ChatMessage message;
  final VoidCallback? onSpeak;

  const _ChatBubble({
    required this.message,
    this.onSpeak,
  });

  @override
  Widget build(BuildContext context) {
    final isUser = message.isUser;
    final alignment =
        isUser ? Alignment.centerRight : Alignment.centerLeft;
    final color = isUser ? Colors.blue[100] : Colors.grey[300];

    return Align(
      alignment: alignment,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Flexible(
              child: Text(message.text),
            ),
            if (!isUser && onSpeak != null) ...[
              const SizedBox(width: 4),
              IconButton(
                icon: const Icon(
                  Icons.volume_up,
                  size: 18,
                ),
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                onPressed: onSpeak,
                tooltip: 'Read this aloud',
              ),
            ],
          ],
        ),
      ),
    );
  }
}
