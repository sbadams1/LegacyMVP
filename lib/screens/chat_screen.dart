// lib/screens/chat_screen.dart
//
// Legacy app chat UI
//
// - Text → AIBrainService.askBrain() → Gemini via Supabase ("ai-brain")
// - Audio:
//     • Record (AAC) → Supabase "speech-to-text" → transcript
//     • Transcript → same text pipeline → AI reply
// - Media (photo/video):
//     • Pick from gallery → upload to GCS via Supabase "video-upload-url"
//     • Show thumbnail/card in chat
//     • Also send base64 snapshot of the file → Supabase "media-ingest"
//       → warm, descriptive Gemini response
//
// NOTE: requires these Flutter packages in pubspec.yaml:
//   supabase_flutter, flutter_sound, path_provider, permission_handler,
//   shared_preferences, image_picker, http, video_player

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_sound/flutter_sound.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:video_player/video_player.dart';

import '../services/ai_brain_service.dart';
import 'settings_screen.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

// In-memory message model for the chat UI
class _ChatMessage {
  final String id;
  final String text;
  final bool isUser;
  final DateTime createdAt;

  final String? imageUrl; // public GCS URL for photos
  final String? videoUrl; // public GCS URL for videos

  _ChatMessage({
    required this.id,
    required this.text,
    required this.isUser,
    required this.createdAt,
    this.imageUrl,
    this.videoUrl,
  });
}

class _ChatScreenState extends State<ChatScreen> {
  // UI controllers
  final TextEditingController _textController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  // Supabase + AI brain
  final SupabaseClient _client = Supabase.instance.client;
  final AIBrainService _aiBrain = AIBrainService.instance;

  // In-memory message list
  final List<_ChatMessage> _messages = [];

  // Recorder
  final FlutterSoundRecorder _recorder = FlutterSoundRecorder();
  bool _recorderInited = false;
  bool _isRecording = false;

  // Recording
  String? _recordingPath;
  int _recordDuration = 0;
  Timer? _recordTimer;

  // Mic preference + toast
  bool _micEnabled = false; // persists via SharedPreferences
  bool _micToastShown = false;

  // Sending state
  bool _isSending = false;

  // Media picker
  final ImagePicker _imagePicker = ImagePicker();

  // Upload progress
  double _uploadProgress = 0.0;
  bool _showUploadProgress = false;

  @override
  void initState() {
    super.initState();
    _initRecorder();
    _loadMicPrefs();
  }

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    _recordTimer?.cancel();
    _recorder.closeRecorder();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    });
  }

  String _formatDuration(int seconds) {
    final m = seconds ~/ 60;
    final s = seconds % 60;
    final mm = m.toString().padLeft(2, '0');
    final ss = s.toString().padLeft(2, '0');
    return '$mm:$ss';
  }

  // ---------------------------------------------------------------------------
  // Mic prefs
  // ---------------------------------------------------------------------------

  Future<void> _loadMicPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _micEnabled = prefs.getBool('mic_enabled') ?? false;
      _micToastShown = prefs.getBool('mic_toast_shown') ?? false;
    });
  }

  Future<void> _setMicEnabled(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('mic_enabled', value);
    setState(() {
      _micEnabled = value;
    });
  }

  Future<void> _setMicToastShown(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('mic_toast_shown', value);
    setState(() {
      _micToastShown = value;
    });
  }

  // ---------------------------------------------------------------------------
  // Recorder + mic
  // ---------------------------------------------------------------------------

  Future<bool> _ensureMicPermission() async {
    final status = await Permission.microphone.status;
    if (status.isGranted) return true;

    final result = await Permission.microphone.request();
    return result.isGranted;
  }

  Future<void> _initRecorder() async {
    try {
      final permOk = await _ensureMicPermission();
      if (!permOk) {
        _showSnack('Microphone permission is required to record audio.');
        return;
      }

      await _recorder.openRecorder();
      _recorderInited = true;
    } catch (e) {
      _showSnack('Failed to initialize recorder: $e');
    }
  }

  Future<void> _toggleMicEnabled() async {
    final newValue = !_micEnabled;

    if (!newValue) {
      await _setMicEnabled(false);
      _showSnack('Microphone disabled.');
      return;
    }

    // Enabling mic
    final permOk = await _ensureMicPermission();
    if (!permOk) {
      _showSnack('Microphone permission denied.');
      return;
    }

    await _setMicEnabled(true);

    if (!_micToastShown) {
      _showSnack(
        'Mic enabled. Tap the mic button at the bottom to record your story.',
      );
      await _setMicToastShown(true);
    }
  }

  Future<void> _startRecording() async {
    if (!_recorderInited) {
      _showSnack('Recorder not ready yet. Please try again in a moment.');
      return;
    }

    final micOk = await _ensureMicPermission();
    if (!micOk) {
      _showSnack('Microphone permission is required.');
      return;
    }

    try {
      final dir = await getTemporaryDirectory();
      final path =
          '${dir.path}/legacy_recording_${DateTime.now().millisecondsSinceEpoch}.aac';

      _recordingPath = path;
      _recordDuration = 0;

      await _recorder.startRecorder(
        toFile: path,
        codec: Codec.aacADTS,
      );

      _recordTimer?.cancel();
      _recordTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        setState(() {
          _recordDuration += 1;
        });
      });

      setState(() {
        _isRecording = true;
      });
    } catch (e) {
      _showSnack('Error starting recording: $e');
    }
  }

  Future<void> _stopRecorderOnly() async {
    if (!_recorderInited || !_isRecording) return;
    try {
      await _recorder.stopRecorder();
    } catch (_) {
      // ignore
    }
  }

  Future<void> _stopRecordingAndSend() async {
    await _stopRecorderOnly();
    _recordTimer?.cancel();

    if (!mounted) return;
    setState(() {
      _isRecording = false;
    });

    await _sendRecordingToSttAndChat();
  }

  Future<void> _sendRecordingToSttAndChat() async {
    if (_recordingPath == null) {
      _showSnack('No recording available.');
      return;
    }

    final file = File(_recordingPath!);
    if (!await file.exists()) {
      _showSnack('Recorded file no longer exists.');
      return;
    }

    try {
      final bytes = await file.readAsBytes();
      final base64Audio = base64Encode(bytes);

      final user = _client.auth.currentUser;
      if (user == null) {
        _showSnack('You must be logged in to transcribe audio.');
        return;
      }

      // Temporary "transcribing" bubble
      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: '[🎙️ Audio story – transcribing…]',
            isUser: true,
            createdAt: DateTime.now(),
          ),
        );
      });

      _scrollToBottom();

      // Call speech-to-text Edge Function
      final res = await _client.functions.invoke(
        'speech-to-text',
        body: {
          'user_id': user.id,
          'audio_base64': base64Audio,
          'mime_type': 'audio/aac',
        },
      );

      final data = res.data;
      if (data is! Map<String, dynamic>) {
        _showSnack('Unexpected STT response.');
        return;
      }

      if (data['error'] != null) {
        final errorMessage = data['error'].toString();
        _showSnack('STT error: $errorMessage');
        return;
      }

      final transcript = data['transcript'] as String?;
      if (transcript == null || transcript.trim().isEmpty) {
        _showSnack('No transcript returned from STT.');
        return;
      }

      // Replace the "transcribing" bubble with the real transcript
      setState(() {
        final index = _messages.lastIndexWhere(
          (m) =>
              m.text.startsWith('[🎙️ Audio story – transcribing…]') &&
              m.isUser,
        );
        if (index != -1) {
          final old = _messages[index];
          _messages[index] = _ChatMessage(
            id: old.id,
            text: transcript.trim(),
            isUser: true,
            createdAt: old.createdAt,
          );
        }
      });

      _scrollToBottom();

      // Send to AI but DO NOT add another user bubble
      await _sendTextMessage(transcript, showUserBubble: false);
    } catch (e, st) {
      // ignore: avoid_print
      print('speech-to-text exception: $e');
      // ignore: avoid_print
      print('speech-to-text stack: $st');
      _showSnack('Failed to transcribe audio: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Text → AI brain
  // ---------------------------------------------------------------------------

  void _handleSendPressed() async {
    final text = _textController.text;
    _textController.clear();

    if (text.trim().isEmpty) return;

    await _sendTextMessage(text);
  }

  Future<void> _sendTextMessage(
    String text, {
    bool showUserBubble = true,
  }) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || _isSending) return;

    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in to chat.');
      return;
    }

    if (showUserBubble) {
      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: trimmed,
            isUser: true,
            createdAt: DateTime.now(),
          ),
        );
      });

      _scrollToBottom();
    }

    setState(() {
      _isSending = true;
    });

    try {
      final aiText = await _aiBrain.askBrain(message: trimmed);

      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: aiText,
            isUser: false,
            createdAt: DateTime.now(),
          ),
        );
      });

      _scrollToBottom();
    } catch (e) {
      _showSnack('Error talking to AI: $e');
    } finally {
      if (mounted) {
        setState(() {
          _isSending = false;
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GCS upload helper (photo + video)
  // ---------------------------------------------------------------------------

  Future<String?> _uploadToGcs({
    required File file,
    required String objectName,
    required String contentType,
  }) async {
    try {
      final user = _client.auth.currentUser;
      if (user == null) {
        _showSnack('You must be logged in to upload media.');
        return null;
      }

      final length = await file.length();

      // 1) Get signed upload URL from Supabase Edge Function
      final res = await _client.functions.invoke(
        'video-upload-url', // used for both photos & videos
        body: {
          'fileName': objectName,
          'contentType': contentType,
          'contentLength': length,
        },
      );

      if (res.status != 200) {
        _showSnack('Failed to get upload URL (${res.status}).');
        return null;
      }

      final data = res.data as Map<String, dynamic>;
      final uploadUrl = data['uploadUrl'] as String?;
      final returnedObjectName = data['objectName'] as String?;

      if (uploadUrl == null || returnedObjectName == null) {
        _showSnack('Invalid upload URL or object name.');
        return null;
      }

      final bytes = await file.readAsBytes();

      setState(() {
        _showUploadProgress = true;
        _uploadProgress = 0.3;
      });

      final request = http.Request('PUT', Uri.parse(uploadUrl))
        ..headers['Content-Type'] = contentType
        ..headers['Content-Length'] = length.toString()
        ..bodyBytes = bytes;

      final response = await request.send();
      final responseBody = await response.stream.bytesToString();

      if (response.statusCode != 200 && response.statusCode != 201) {
        // ignore: avoid_print
        print(
            'Upload failed: status=${response.statusCode} body=$responseBody');
        _showSnack('Failed to upload media to storage.');
        return null;
      }

      setState(() {
        _uploadProgress = 1.0;
      });

      // Public URL (bucket is already public for objects)
      final publicUrl =
          'https://storage.googleapis.com/legacy-user-media/$returnedObjectName';

      // ignore: avoid_print
      print('✅ GCS upload complete. URL: $publicUrl');

      return publicUrl;
    } catch (e, st) {
      // ignore: avoid_print
      print('Error uploading to GCS: $e\n$st');
      _showSnack('Error uploading media: $e');
      return null;
    } finally {
      if (mounted) {
        Future.delayed(const Duration(milliseconds: 600), () {
          if (!mounted) return;
          setState(() {
            _showUploadProgress = false;
            _uploadProgress = 0.0;
          });
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Call media-ingest (Gemini) with base64 media
  // ---------------------------------------------------------------------------

  Future<String?> _describeMediaWithGemini({
    required File file,
    required String mimeType,
    required String mediaType, // "image" | "video"
  }) async {
    try {
      final user = _client.auth.currentUser;
      if (user == null) {
        _showSnack('You must be logged in for AI description.');
        return null;
      }

      final bytes = await file.readAsBytes();
      final base64Media = base64Encode(bytes);
      final fileName = file.path.split(Platform.pathSeparator).last;

      final res = await _client.functions.invoke(
        'media-ingest',
        body: {
          'user_id': user.id,
          'media_base64': base64Media,
          'mime_type': mimeType,
          'media_type': mediaType,
          'file_name': fileName,
        },
      );

      if (res.status != 200) {
        _showSnack('AI description failed (${res.status}).');
        return null;
      }

      final data = res.data;
      if (data is! Map<String, dynamic>) {
        _showSnack('Unexpected AI response.');
        return null;
      }

      final desc = data['description'] as String?;
      if (desc == null || desc.trim().isEmpty) {
        return null;
      }

      return desc.trim();
    } catch (e, st) {
      // ignore: avoid_print
      print('media-ingest exception: $e');
      // ignore: avoid_print
      print('media-ingest stack: $st');
      _showSnack('Failed to get AI description: $e');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Media buttons
  // ---------------------------------------------------------------------------

  Future<void> _onAddPhotoPressed() async {
    final picked = await _imagePicker.pickImage(source: ImageSource.gallery);
    if (picked == null) return;

    final file = File(picked.path);
    final objectName =
        'photos/${DateTime.now().millisecondsSinceEpoch}_${picked.name}';

    // Add a temporary user bubble
    setState(() {
      _messages.add(
        _ChatMessage(
          id: UniqueKey().toString(),
          text: '[Uploading photo…]',
          isUser: true,
          createdAt: DateTime.now(),
        ),
      );
    });

    final tempIndex = _messages.length - 1;

    try {
      // 1) Upload to GCS
      final gcsUrl = await _uploadToGcs(
        file: file,
        objectName: objectName,
        contentType: 'image/jpeg',
      );
      if (gcsUrl == null) return;

      // 2) Replace temporary bubble with real one (thumbnail + label)
      setState(() {
        final old = _messages[tempIndex];
        _messages[tempIndex] = _ChatMessage(
          id: old.id,
          text: 'Photo uploaded.',
          isUser: true,
          createdAt: old.createdAt,
          imageUrl: gcsUrl,
        );
      });

      _scrollToBottom();

      // 3) Ask Gemini for a rich, warm description via media-ingest
      final desc = await _describeMediaWithGemini(
        file: file,
        mimeType: 'image/jpeg',
        mediaType: 'image',
      );

      final aiText = desc ??
          'I see you shared a photo that looks meaningful — tell me more about what was happening in this moment.';

      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: aiText,
            isUser: false,
            createdAt: DateTime.now(),
          ),
        );
      });

      _scrollToBottom();
    } catch (e) {
      _showSnack('Photo upload failed: $e');
    }
  }

  Future<void> _onAddVideoPressed() async {
    final picked = await _imagePicker.pickVideo(source: ImageSource.gallery);
    if (picked == null) return;

    final file = File(picked.path);
    final objectName =
        'videos/${DateTime.now().millisecondsSinceEpoch}_${picked.name}';

    // Temporary user bubble
    setState(() {
      _messages.add(
        _ChatMessage(
          id: UniqueKey().toString(),
          text: '[Uploading video…]',
          isUser: true,
          createdAt: DateTime.now(),
        ),
      );
    });

    final tempIndex = _messages.length - 1;

    try {
      // 1) Upload to GCS
      final gcsUrl = await _uploadToGcs(
        file: file,
        objectName: objectName,
        contentType: 'video/mp4',
      );
      if (gcsUrl == null) return;

      // 2) Replace temp bubble with a video card + label
      setState(() {
        final old = _messages[tempIndex];
        _messages[tempIndex] = _ChatMessage(
          id: old.id,
          text: 'Video uploaded.',
          isUser: true,
          createdAt: old.createdAt,
          videoUrl: gcsUrl,
        );
      });

      _scrollToBottom();

      // 3) For now, DO NOT call media-ingest for video (too heavy).
      //    Just add a warm, inviting prompt as an AI message.
      const aiText =
          'I see you captured a moment on video — what was happening here, and why does this clip matter to you?';

      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: aiText,
            isUser: false,
            createdAt: DateTime.now(),
          ),
        );
      });

      _scrollToBottom();
    } catch (e) {
      _showSnack('Video upload failed: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Legacy'),
        actions: [
          IconButton(
            icon: Icon(_micEnabled ? Icons.mic : Icons.mic_off),
            tooltip: _micEnabled ? 'Disable microphone' : 'Enable microphone',
            onPressed: _toggleMicEnabled,
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: 'Settings',
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => const SettingsScreen(),
                ),
              );
            },
          ),
        ],
      ),
      body: Column(
        children: [
          if (_showUploadProgress)
            LinearProgressIndicator(
              value: _uploadProgress == 0.0 ? null : _uploadProgress,
              minHeight: 4,
            ),
          Expanded(
            child: _messages.isEmpty
                ? _buildEmptyState(theme)
                : _buildMessageList(theme),
          ),
          if (_isRecording) _buildRecordingIndicator(),
          _buildMediaToolbar(),
          _buildInputBar(theme),
        ],
      ),
    );
  }

  Widget _buildEmptyState(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: const [
            Text(
              "What's on your mind today?",
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            SizedBox(height: 12),
            Text(
              "You can:",
              style: TextStyle(fontSize: 14),
            ),
            SizedBox(height: 8),
            Text(
              "• Continue your legacy interview",
              style: TextStyle(fontSize: 14),
            ),
            Text(
              "• Tell a story about something that happened today",
              style: TextStyle(fontSize: 14),
            ),
            Text(
              "• Vent about something that's bothering you",
              style: TextStyle(fontSize: 14),
            ),
            Text(
              "• Share a memory from childhood",
              style: TextStyle(fontSize: 14),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList(ThemeData theme) {
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
      itemCount: _messages.length,
      itemBuilder: (context, index) {
        final msg = _messages[index];
        final isUser = msg.isUser;

        final alignment =
            isUser ? Alignment.centerRight : Alignment.centerLeft;
        final bubbleColor = isUser
            ? theme.colorScheme.primary
            : theme.colorScheme.surfaceVariant;
        final textColor = isUser
            ? theme.colorScheme.onPrimary
            : theme.colorScheme.onSurface;

        return Align(
          alignment: alignment,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
            decoration: BoxDecoration(
              color: bubbleColor,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // IMAGE THUMBNAIL
                if (msg.imageUrl != null) ...[
                  GestureDetector(
                    onTap: () {
                      // Just show the image larger in a dialog (optional)
                      showDialog(
                        context: context,
                        builder: (_) {
                          return Dialog(
                            child: InteractiveViewer(
                              child: Image.network(
                                msg.imageUrl!,
                                fit: BoxFit.contain,
                              ),
                            ),
                          );
                        },
                      );
                    },
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.network(
                        msg.imageUrl!,
                        height: 200,
                        width: 200,
                        fit: BoxFit.cover,
                        errorBuilder: (context, error, stackTrace) {
                          return const SizedBox(
                            height: 80,
                            child: Center(
                              child: Text('Image failed to load'),
                            ),
                          );
                        },
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],

                // VIDEO CARD (tap to open player)
                if (msg.videoUrl != null) ...[
                  GestureDetector(
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) =>
                              VideoPlayerScreen(videoUrl: msg.videoUrl!),
                        ),
                      );
                    },
                    child: Container(
                      width: 220,
                      height: 130,
                      decoration: BoxDecoration(
                        color: Colors.black12,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Center(
                        child: Icon(
                          Icons.play_circle_fill,
                          size: 48,
                          color: Colors.black54,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],

                // TEXT
                if (msg.text.isNotEmpty)
                  Text(
                    msg.text,
                    style: TextStyle(color: textColor, height: 1.3),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildMediaToolbar() {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        children: [
          TextButton.icon(
            onPressed: _onAddPhotoPressed,
            icon: const Icon(Icons.photo),
            label: const Text('Add Photo'),
          ),
          const SizedBox(width: 8),
          TextButton.icon(
            onPressed: _onAddVideoPressed,
            icon: const Icon(Icons.videocam),
            label: const Text('Add Video'),
          ),
        ],
      ),
    );
  }

  Widget _buildRecordingIndicator() {
    return Container(
      color: Colors.red.withOpacity(0.08),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          const Icon(Icons.fiber_manual_record, color: Colors.red),
          const SizedBox(width: 8),
          Text(
            'Recording… ${_formatDuration(_recordDuration)}',
            style: const TextStyle(color: Colors.red),
          ),
          const Spacer(),
          TextButton(
            onPressed: _stopRecordingAndSend,
            child: const Text('Stop & Send'),
          ),
        ],
      ),
    );
  }

  Widget _buildInputBar(ThemeData theme) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.06),
              blurRadius: 4,
              offset: const Offset(0, -2),
            ),
          ],
        ),
        child: Row(
          children: [
            IconButton(
              onPressed: () async {
                if (!_micEnabled) {
                  _showSnack(
                    'Mic is OFF. Enable it using the top-right mic icon.',
                  );
                  return;
                }
                if (_isRecording) {
                  await _stopRecordingAndSend();
                } else {
                  await _startRecording();
                }
              },
              icon: Icon(
                _isRecording ? Icons.stop : Icons.mic,
                color: _micEnabled
                    ? theme.colorScheme.primary
                    : theme.disabledColor,
              ),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: TextField(
                controller: _textController,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _handleSendPressed(),
                decoration: const InputDecoration(
                  hintText: 'Type a message or record your story…',
                  border: OutlineInputBorder(),
                  isDense: true,
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                ),
                minLines: 1,
                maxLines: 4,
              ),
            ),
            const SizedBox(width: 8),
            IconButton(
              onPressed: _isSending ? null : _handleSendPressed,
              icon: _isSending
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
            ),
          ],
        ),
      ),
    );
  }
}

// -----------------------------------------------------------------------------
// Simple full-screen video player for the video bubbles
// -----------------------------------------------------------------------------

class VideoPlayerScreen extends StatefulWidget {
  final String videoUrl;

  const VideoPlayerScreen({super.key, required this.videoUrl});

  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  late VideoPlayerController _controller;
  bool _initialized = false;

  @override
  void initState() {
    super.initState();
    _controller = VideoPlayerController.network(widget.videoUrl)
      ..initialize().then((_) {
        if (!mounted) return;
        setState(() {
          _initialized = true;
        });
        _controller.play();
      });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text(
          'Video',
          style: TextStyle(color: Colors.white),
        ),
      ),
      body: Center(
        child: _initialized
            ? AspectRatio(
                aspectRatio: _controller.value.aspectRatio,
                child: VideoPlayer(_controller),
              )
            : const CircularProgressIndicator(),
      ),
      floatingActionButton: _initialized
          ? FloatingActionButton(
              onPressed: () {
                setState(() {
                  if (_controller.value.isPlaying) {
                    _controller.pause();
                  } else {
                    _controller.play();
                  }
                });
              },
              child: Icon(
                _controller.value.isPlaying ? Icons.pause : Icons.play_arrow,
              ),
            )
          : null,
    );
  }
}
