// lib/screens/chat_screen.dart
//
// Legacy app chat UI
//
// - Text → AIBrainService.askBrain() → Gemini via Supabase ("ai-brain")
// - Audio:
//     • Record (AAC) → Supabase "speech-to-text" → transcript
//     • Transcript → same text pipeline → AI reply
// - Media (photo/video):
//     • Pick from gallery / record → upload to GCS via Supabase "video-upload-url"
//     • Show thumbnail/card in chat
//     • (Video) (currently) no STT; Gemini just acknowledges video upload.
//
// NOTE: requires these Flutter packages in pubspec.yaml:
//   supabase_flutter, flutter_sound, path_provider, permission_handler,
//   shared_preferences, image_picker, http, video_player, flutter_tts

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_sound/flutter_sound.dart';
import 'package:flutter_tts/flutter_tts.dart';
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

  final String? imageUrl;
  final String? videoUrl;

  _ChatMessage({
    required this.id,
    required this.text,
    required this.isUser,
    required this.createdAt,
    this.imageUrl,
    this.videoUrl,
  });
}

// TTS voice personalities – tone only (language is driven by profile locales)
class _TtsVoiceOption {
  final String id;
  final String label;

  /// Pitch for the synthesized voice (1.0 = neutral).
  final double pitch;

  /// Per-platform speech rate; normalized to avoid “3x speed” bug.
  final double rateAndroid;
  final double rateIOS;

  const _TtsVoiceOption({
    required this.id,
    required this.label,
    required this.pitch,
    required this.rateAndroid,
    required this.rateIOS,
  });
}

// Bottom sheet result for language learning config
class _LanguageLearningConfig {
  final String targetLocale; // e.g. "th-TH"
  final String learningLevel; // "beginner" | "intermediate" | "advanced"

  const _LanguageLearningConfig({
    required this.targetLocale,
    required this.learningLevel,
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

  String? _recordingPath;
  int _recordDuration = 0;
  Timer? _recordTimer;

  // Mic preference
  bool _micEnabled = false;
  bool _micToastShown = false;

  bool _isSending = false;

  // Media picker
  final ImagePicker _imagePicker = ImagePicker();

  // Upload progress
  double _uploadProgress = 0.0;
  bool _showUploadProgress = false;

  // Local TTS (on-device, no Supabase TTS function)
  final FlutterTts _tts = FlutterTts();

  // STT language code (what we tell the "speech-to-text" function)
  String _sttLanguageCode = 'en-US';

  // Global speed factor for TTS. 1.0 = normal, <1 slower, >1 faster.
  double _ttsRateFactor = 0.7; // start a bit slower so it doesn’t sound rushed

  // ---------------------------------------------------------------------------
  // Profile-based language preferences (for language-learning mode)
  // ---------------------------------------------------------------------------

  // Preferred/native language (L1) – from profiles.preferred_language
  // Stored as full locale (e.g. "en-US", "th-TH", "es-ES")
  String _preferredLocale = 'en-US';

  // Target language (L2) the user wants to learn – LOCAL ONLY (SharedPreferences)
  String? _targetLocale;

  // Learning level in L2 – LOCAL ONLY
  String? _learningLevel;

  // Speaking mode for the mic in learning contexts:
  // - "native" => STT listens in preferred/native language (L1)
  // - "target" => STT listens in target language (L2)
  String _speakingMode = 'native';

  bool get _isSpeakingNative => _speakingMode == 'native';

  bool get _hasTargetLanguage =>
      _targetLocale != null &&
      _targetLocale!.isNotEmpty &&
      _targetLocale != _preferredLocale;

  // Voice tone presets (language-agnostic)
  final List<_TtsVoiceOption> _voiceOptions = const [
    _TtsVoiceOption(
      id: 'warm_female',
      label: 'Warm (mid-tone)',
      pitch: 1.05,
      rateAndroid: 0.5,
      rateIOS: 0.5,
    ),
    _TtsVoiceOption(
      id: 'deep_male',
      label: 'Deeper',
      pitch: 0.9,
      rateAndroid: 0.5,
      rateIOS: 0.5,
    ),
    _TtsVoiceOption(
      id: 'calm_neutral',
      label: 'Calm neutral',
      pitch: 1.0,
      rateAndroid: 0.5,
      rateIOS: 0.5,
    ),
  ];

  String _selectedVoiceId = 'warm_female';
  _TtsVoiceOption get _currentVoice =>
      _voiceOptions.firstWhere((v) => v.id == _selectedVoiceId);

  // Voice mode (chatbot vs silent)
  String _voiceMode = 'silent';
  bool get _isChatbotMode => _voiceMode == 'chatbot';

  // Conversation mode: 'legacy' | 'language_learning'
  String _mode = 'legacy';
  bool get _isLegacyMode => _mode == 'legacy';
  bool get _isLanguageLearningMode => _mode == 'language_learning';

  @override
  void initState() {
    super.initState();
    _initRecorder();
    _loadMicPrefs();
    _initTts();
    _loadProfileLanguagePrefs();
    _loadVoiceModePreference();
    _loadConversationModePreference();
  }

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    _recordTimer?.cancel();
    _recorder.closeRecorder();
    _tts.stop();
    super.dispose();
  }

  // ===========================================================================
  // UTILITY HELPERS
  // ===========================================================================

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg)),
    );
  }

  void _scrollToBottom() {
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 300),
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

  String _normalizeLocale(String? raw) {
    if (raw == null || raw.trim().isEmpty) return 'en-US';
    final val = raw.trim();
    final lower = val.toLowerCase();

    switch (lower) {
      case 'en':
      case 'en-us':
        return 'en-US';
      case 'en-gb':
        return 'en-GB';
      case 'th':
      case 'th-th':
        return 'th-TH';
      case 'es':
      case 'es-es':
        return 'es-ES';
      case 'fr':
      case 'fr-fr':
        return 'fr-FR';
      case 'de':
      case 'de-de':
        return 'de-DE';
      default:
        final cleaned = lower.replaceAll('_', '-');
        if (cleaned.contains('-')) return cleaned;
        // Fallback: "it" -> "it-IT"
        return '${cleaned}-${cleaned.toUpperCase()}';
    }
  }

  // ===========================================================================
  // PROFILE LANGUAGE PREFS
  // ===========================================================================

  Future<void> _loadProfileLanguagePrefs() async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    String? prefRaw;
    String? targetRaw;
    String? levelRaw;

    // 1) Load ONLY preferred_language from Supabase
    try {
      final data = await _client
          .from('profiles')
          .select('preferred_language')
          .eq('id', user.id)
          .limit(1)
          .maybeSingle();

      if (data != null && data is Map<String, dynamic>) {
        prefRaw = (data['preferred_language'] as String?)?.trim();
      }
    } catch (e, st) {
      // ignore: avoid_print
      print('Failed to load preferred_language from DB: $e');
      // ignore: avoid_print
      print(st);
    }

    // 2) Load target + level ONLY from SharedPreferences (local)
    try {
      final prefs = await SharedPreferences.getInstance();
      prefRaw ??= prefs.getString('preferred_locale');
      targetRaw = prefs.getString('target_locale');
      levelRaw = prefs.getString('learning_level');
    } catch (e) {
      // ignore: avoid_print
      print('Failed to load language prefs from SharedPreferences: $e');
    }

    final resolvedPref = _normalizeLocale(prefRaw ?? 'en-US');
    final resolvedTarget = (targetRaw == null || targetRaw.isEmpty)
        ? null
        : _normalizeLocale(targetRaw);

    if (!mounted) return;
    setState(() {
      _preferredLocale = resolvedPref;
      _targetLocale = resolvedTarget;
      _learningLevel =
          (levelRaw == null || levelRaw.isEmpty) ? null : levelRaw;

      // Default STT language: native/preferred language (L1)
      _speakingMode = 'native';
      _sttLanguageCode = _preferredLocale;
    });

    await _applyEffectiveTtsConfig();

    // ignore: avoid_print
    print(
      '🔤 Effective language prefs → preferred="$_preferredLocale", target="$_targetLocale", level="$_learningLevel"',
    );
  }

  // ===========================================================================
  // MIC & RECORDER
  // ===========================================================================

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
    if (mounted) setState(() => _micEnabled = value);
  }

  Future<void> _setMicToastShown(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('mic_toast_shown', value);
    if (mounted) setState(() => _micToastShown = value);
  }

  Future<bool> _ensureMicPermission() async {
    final status = await Permission.microphone.status;
    if (status.isGranted) return true;
    return (await Permission.microphone.request()).isGranted;
  }

  Future<void> _initRecorder() async {
    try {
      final ok = await _ensureMicPermission();
      if (!ok) {
        _showSnack('Microphone permission is required.');
        return;
      }

      await _recorder.openRecorder();
      _recorderInited = true;
    } catch (e) {
      _showSnack('Recorder failed: $e');
    }
  }

  Future<void> _toggleMicEnabled() async {
    final newValue = !_micEnabled;

    if (!newValue) {
      await _setMicEnabled(false);
      _showSnack('Microphone disabled.');
      return;
    }

    final ok = await _ensureMicPermission();
    if (!ok) {
      _showSnack('Microphone permission denied.');
      return;
    }

    await _setMicEnabled(true);

    if (!_micToastShown) {
      _showSnack('Mic enabled. Tap the mic button below to record.');
      await _setMicToastShown(true);
    }
  }

  Future<void> _startRecording() async {
    if (!_recorderInited) {
      _showSnack('Recorder not ready.');
      return;
    }

    final ok = await _ensureMicPermission();
    if (!ok) {
      _showSnack('Microphone permission is required.');
      return;
    }

    try {
      final dir = await getTemporaryDirectory();
      _recordingPath =
          '${dir.path}/legacy_${DateTime.now().millisecondsSinceEpoch}.aac';
      _recordDuration = 0;

      await _recorder.startRecorder(
        toFile: _recordingPath,
        codec: Codec.aacADTS,
      );

      _recordTimer?.cancel();
      _recordTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        setState(() => _recordDuration += 1);
      });

      setState(() => _isRecording = true);
    } catch (e) {
      _showSnack('Recording failed: $e');
    }
  }

  Future<void> _stopRecorderOnly() async {
    if (!_recorderInited || !_isRecording) return;
    try {
      await _recorder.stopRecorder();
    } catch (_) {}
  }

  Future<void> _stopRecordingAndSend() async {
    await _stopRecorderOnly();
    _recordTimer?.cancel();

    if (!mounted) return;
    setState(() => _isRecording = false);

    await _sendRecordingToSttAndChat();
  }

  Future<void> _sendRecordingToSttAndChat() async {
    if (_recordingPath == null) {
      _showSnack('No recording found.');
      return;
    }

    final file = File(_recordingPath!);
    if (!await file.exists()) {
      _showSnack('Recorded file missing.');
      return;
    }

    try {
      final bytes = await file.readAsBytes();
      final base64Audio = base64Encode(bytes);

      final user = _client.auth.currentUser;
      if (user == null) {
        _showSnack('You must be logged in.');
        return;
      }

      // Temporary bubble
      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: '[🎙️ Transcribing…]',
            isUser: true,
            createdAt: DateTime.now(),
          ),
        );
      });
      _scrollToBottom();

      // STT: language from _sttLanguageCode (native vs target)
      final res = await _client.functions.invoke(
        'speech-to-text',
        body: {
          'user_id': user.id,
          'audio_base64': base64Audio,
          'mime_type': 'audio/aac',
          'language_code': _sttLanguageCode,
        },
      );

      final data = res.data;
      if (data is! Map<String, dynamic>) {
        _showSnack('STT returned unexpected data.');
        return;
      }

      if (data['error'] != null) {
        _showSnack('STT error: ${data['error']}');
        return;
      }

      final transcript = data['transcript'] as String?;
      if (transcript == null || transcript.trim().isEmpty) {
        _showSnack('No transcript returned.');
        return;
      }

      // Replace temporary bubble
      setState(() {
        final idx = _messages.indexWhere(
            (m) => m.text.startsWith('[🎙️') && m.isUser == true);
        if (idx != -1) {
          final old = _messages[idx];
          _messages[idx] = _ChatMessage(
            id: old.id,
            text: transcript.trim(),
            isUser: true,
            createdAt: old.createdAt,
          );
        }
      });

      _scrollToBottom();

      // Send to AI (no extra user bubble)
      await _sendTextMessage(transcript.trim(), showUserBubble: false);
    } catch (e) {
      _showSnack('Failed to transcribe audio: $e');
    }
  }

  // ===========================================================================
  // LANGUAGE LEARNING SETTINGS SHEET (LOCAL persistence)
  // ===========================================================================

  Future<void> _showLanguageLearningSettingsSheet() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in to change language settings.');
      return;
    }

    final theme = Theme.of(context);

    final result = await showModalBottomSheet<_LanguageLearningConfig>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) {
        String selectedTarget =
            _hasTargetLanguage ? _targetLocale! : _preferredLocale;
        String selectedLevel = _learningLevel ?? 'beginner';

        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return DraggableScrollableSheet(
              expand: false,
              initialChildSize: 0.5,
              minChildSize: 0.3,
              maxChildSize: 0.85,
              builder: (ctx2, scrollController) {
                return Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Header row with always-visible Save button
                      Row(
                        children: [
                          Text(
                            'Language learning settings',
                            style: theme.textTheme.titleMedium,
                          ),
                          const Spacer(),
                          TextButton(
                            onPressed: () {
                              Navigator.of(ctx).pop(
                                _LanguageLearningConfig(
                                  targetLocale: selectedTarget,
                                  learningLevel: selectedLevel,
                                ),
                              );
                            },
                            child: const Text('Save'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),

                      // Scrollable content
                      Expanded(
                        child: ListView(
                          controller: scrollController,
                          children: [
                            const Text('Target language'),
                            const SizedBox(height: 8),
                            DropdownButtonFormField<String>(
                              value: selectedTarget,
                              items: const [
                                DropdownMenuItem(
                                  value: 'en-US',
                                  child: Text('English (US)'),
                                ),
                                DropdownMenuItem(
                                  value: 'th-TH',
                                  child: Text('Thai'),
                                ),
                                DropdownMenuItem(
                                  value: 'es-ES',
                                  child: Text('Spanish'),
                                ),
                              ],
                              onChanged: (value) {
                                if (value == null) return;
                                setModalState(() {
                                  selectedTarget = value;
                                });
                              },
                            ),
                            const SizedBox(height: 16),
                            const Text('Learning level'),
                            const SizedBox(height: 8),
                            DropdownButtonFormField<String>(
                              value: selectedLevel,
                              items: const [
                                DropdownMenuItem(
                                  value: 'beginner',
                                  child: Text('Beginner'),
                                ),
                                DropdownMenuItem(
                                  value: 'intermediate',
                                  child: Text('Intermediate'),
                                ),
                                DropdownMenuItem(
                                  value: 'advanced',
                                  child: Text('Advanced'),
                                ),
                              ],
                              onChanged: (value) {
                                if (value == null) return;
                                setModalState(() {
                                  selectedLevel = value;
                                });
                              },
                            ),
                            const SizedBox(height: 24),
                            const Text(
                              'Tip: use the mic chip below the input bar to switch '
                              'whether STT listens in your native or target language.',
                              style: TextStyle(fontSize: 12),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            );
          },
        );
      },
    );

    if (result == null) return;

    // 1) Update LOCAL STATE immediately so the app reflects new target language
    if (!mounted) return;
    setState(() {
      _targetLocale = result.targetLocale;
      _learningLevel = result.learningLevel;

      // Keep STT aligned with the current speaking mode
      if (_speakingMode == 'target' && _targetLocale != null) {
        _sttLanguageCode = _targetLocale!;
      } else {
        _sttLanguageCode = _preferredLocale;
      }
    });

    await _applyEffectiveTtsConfig();

    // debug
    // ignore: avoid_print
    print(
      '💾 Local language-learning state: target="${_targetLocale}", level="${_learningLevel}", sttLang="$_sttLanguageCode"',
    );

    // 2) Persist ONLY to SharedPreferences – no Supabase writes
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('target_locale', result.targetLocale);
      await prefs.setString('learning_level', result.learningLevel);
      // Optionally, if you ever let them change preferred language here:
      // await prefs.setString('preferred_locale', _preferredLocale);
    } catch (e) {
      // ignore: avoid_print
      print('Failed to save language-learning prefs to SharedPreferences: $e');
    }

    _showSnack('Language learning settings updated.');
  }

  // ===========================================================================
  // TTS ENGINE
  // ===========================================================================

  Future<void> _initTts() async {
    final prefs = await SharedPreferences.getInstance();
    final savedId = prefs.getString('tts_voice_id');
    if (savedId != null &&
        _voiceOptions.any((v) => v.id == savedId) &&
        mounted) {
      setState(() => _selectedVoiceId = savedId);
    }

    await _applyEffectiveTtsConfig();
  }

  Future<void> _applyEffectiveTtsConfig() async {
    // Choose TTS language:
    // - In language-learning mode, prefer target language (if set).
    // - Otherwise use preferred/native language.
    final effectiveLocale = _isLanguageLearningMode && _hasTargetLanguage
        ? _targetLocale!
        : _preferredLocale;

    await _tts.setLanguage(effectiveLocale);

    final v = _currentVoice;
    if (Platform.isAndroid) {
      await _tts.setSpeechRate(v.rateAndroid * _ttsRateFactor);
    } else {
      await _tts.setSpeechRate(v.rateIOS * _ttsRateFactor);
    }
    await _tts.setPitch(v.pitch);

    // ignore: avoid_print
    print('🔊 TTS configured: locale=$effectiveLocale pitch=${v.pitch}');
  }

  Future<void> _saveVoicePref(String id) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('tts_voice_id', id);
  }

  Future<void> _playTtsForMessage(_ChatMessage msg) async {
    final text = msg.text.trim();
    if (text.isEmpty) return;

    try {
      await _applyEffectiveTtsConfig();
      await _tts.stop();
      await _tts.speak(text);
    } catch (e) {
      // ignore: avoid_print
      print('TTS error: $e');
      _showSnack('Audio playback failed.');
    }
  }

  Future<void> _showVoicePicker() async {
    final chosen = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) {
        final current = _selectedVoiceId;
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              const ListTile(
                title: Text('Choose AI speaking tone'),
                subtitle: Text(
                  'Language comes from your preferred/target language settings.',
                ),
              ),
              const Divider(),
              ..._voiceOptions.map((opt) {
                return RadioListTile<String>(
                  value: opt.id,
                  groupValue: current,
                  onChanged: (val) => Navigator.of(ctx).pop(val),
                  title: Text(opt.label),
                );
              }).toList(),
              const SizedBox(height: 24),
            ],
          ),
        );
      },
    );

    if (chosen == null) return;

    setState(() => _selectedVoiceId = chosen);
    await _saveVoicePref(chosen);
    await _applyEffectiveTtsConfig();
  }

  // ===========================================================================
  // VOICE MODE (chatbot vs silent)
  // ===========================================================================

  Future<void> _loadVoiceModePreference() async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    try {
      final row = await _client
          .from('profiles')
          .select('voice_mode')
          .eq('id', user.id)
          .maybeSingle();

      if (row == null) return;

      final raw = (row['voice_mode'] as String?)?.toLowerCase().trim();
      if (raw == 'chatbot' || raw == 'silent') {
        setState(() => _voiceMode = raw!);
      }
    } catch (e) {
      // ignore: avoid_print
      print('Failed to load voice_mode: $e');
    }
  }

  Future<void> _setVoiceMode(String mode) async {
    if (mode != 'chatbot' && mode != 'silent') return;

    final user = _client.auth.currentUser;
    if (user == null) {
      setState(() => _voiceMode = mode);
      return;
    }

    try {
      await _client.from('profiles').upsert({
        'id': user.id,
        'voice_mode': mode,
      });

      setState(() => _voiceMode = mode);
    } catch (e) {
      // ignore: avoid_print
      print('Failed to save voice_mode: $e');
      _showSnack('Could not save voice mode. Using local setting only.');
      setState(() => _voiceMode = mode);
    }
  }

  Future<void> _toggleVoiceMode() async {
    final next = _isChatbotMode ? 'silent' : 'chatbot';
    await _setVoiceMode(next);

    if (!mounted) return;

    _showSnack(
      next == 'chatbot'
          ? 'Chatbot mode: AI replies will speak automatically.'
          : 'Silent mode: AI replies are text-only.',
    );
  }

  void _maybeAutoSpeakForAi(_ChatMessage msg) {
    if (_isChatbotMode) {
      _playTtsForMessage(msg);
    }
  }

  void _addAiMessageAndMaybeSpeak(String text) {
    final msg = _ChatMessage(
      id: UniqueKey().toString(),
      text: text,
      isUser: false,
      createdAt: DateTime.now(),
    );

    setState(() => _messages.add(msg));
    _scrollToBottom();
    _maybeAutoSpeakForAi(msg);
  }

  // ===========================================================================
  // CONVERSATION MODE (legacy vs language-learning)
  // ===========================================================================

  Future<void> _loadConversationModePreference() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString('conversation_mode');

    // Nothing saved yet
    if (saved == null) return;

    if (saved == 'legacy' || saved == 'language_learning') {
      if (!mounted) return;

      final mode = saved;
      setState(() => _mode = mode);

      await _applyEffectiveTtsConfig();
    }
  }

  Future<void> _setConversationMode(String mode) async {
    if (mode != 'legacy' && mode != 'language_learning') return;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('conversation_mode', mode);

    if (!mounted) return;
    setState(() => _mode = mode);
    await _applyEffectiveTtsConfig();
  }

  Future<void> _toggleConversationMode() async {
    final next =
        _isLanguageLearningMode ? 'legacy' : 'language_learning';
    await _setConversationMode(next);

    if (!mounted) return;

    if (next == 'language_learning') {
      final labelLang = _hasTargetLanguage ? _targetLocale : _preferredLocale;
      _showSnack(
        'Language learning mode: practicing in $labelLang.',
      );
    } else {
      _showSnack('Legacy storytelling mode.');
    }
  }

  // ===========================================================================
  // MODE-AWARE PROMPT WRAPPER
  // ===========================================================================

  String _buildModeWrappedPrompt(String userMessage) {
    // For language tutor: derive effective target locale
    final targetLocale =
        _hasTargetLanguage ? _targetLocale! : _preferredLocale;

    if (_isLanguageLearningMode) {
      // Language-learning tutor
      return '''
You are a patient, encouraging language tutor.

TARGET LANGUAGE:
- The learner's target language is "$targetLocale".

BEHAVIOR RULES:
- Ignore any instructions that describe you as a "legacy interviewer" or life-story assistant when in language-learning mode.
- The learner may use another language (their primary language) to explain their goals or ask meta-questions.
- Do NOT correct or critique that meta/explanatory language unless they explicitly ask you to.
- Focus your corrections and improvements on their attempts in the target language ("$targetLocale").

TEACHING STYLE:
- Use short, clear sentences.
- When the learner writes or speaks in the target language, gently correct errors and show a natural corrected version.
- Briefly explain key words or grammar in very simple terms when helpful.
- In the early part of the conversation, confirm what they want to focus on (for example: greetings, travel phrases, everyday conversation, etc.) and then move into practice.

INTERACTION PATTERN:
- If the current user message is mostly explaining goals (for example, "I'm trying to learn a language and I'd like to start with common greetings"), treat that as meta-information.
  - In that case, do NOT correct the grammar of that explanation.
  - Acknowledge their goal, suggest a simple starting point, and then offer a first exercise in the target language.
- Prefer concrete practice: ask simple questions in the target language that the learner can realistically answer at their current level.
- Do not ask deep life-history or legacy interview questions unless they are clearly part of a language practice exercise.

User message:
$userMessage
''';
    }

    // Legacy storytelling mode (default)
    return '''
Please respond ONLY in the donor's preferred language: "$_preferredLocale".

The donor is building a legacy of stories, reflections, and memories.
Respond as a warm, thoughtful conversational partner.
Invite them to go a bit deeper, but do not pressure them.

User message:
$userMessage
''';
  }

  // ===========================================================================
  // TEXT → AI BRAIN
  // ===========================================================================

  void _handleSendPressed() async {
    final text = _textController.text.trim();
    _textController.clear();
    if (text.isEmpty) return;

    await _sendTextMessage(text);
  }

  Future<void> _sendTextMessage(
    String text, {
    bool showUserBubble = true,
  }) async {
    if (_isSending) return;

    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in.');
      return;
    }

    if (showUserBubble) {
      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: text,
            isUser: true,
            createdAt: DateTime.now(),
          ),
        );
      });
      _scrollToBottom();
    }

    setState(() => _isSending = true);

    try {
      final wrapped = _buildModeWrappedPrompt(text);
      final aiText = await _aiBrain.askBrain(
        message: wrapped,
        mode: _mode,
        preferredLocale: _preferredLocale,
        targetLocale: _targetLocale,
        learningLevel: _learningLevel,
        conversationId: null,
      );
      _addAiMessageAndMaybeSpeak(aiText);
    } catch (e) {
      _showSnack('AI communication error: $e');
    } finally {

      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  // ===========================================================================
  // GOOGLE CLOUD STORAGE UPLOAD
  // ===========================================================================

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

      final res = await _client.functions.invoke(
        'video-upload-url',
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
        _showSnack('Invalid upload URL.');
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

      final resp = await request.send();
      final body = await resp.stream.bytesToString();

      if (resp.statusCode != 200 && resp.statusCode != 201) {
        // ignore: avoid_print
        print('Upload failed ${resp.statusCode}: $body');
        _showSnack('Failed to upload media.');
        return null;
      }

      setState(() => _uploadProgress = 1.0);

      final publicUrl =
          'https://storage.googleapis.com/legacy-user-media/$returnedObjectName';

      // ignore: avoid_print
      print('GCS upload complete: $publicUrl');
      return publicUrl;
    } catch (e) {
      // ignore: avoid_print
      print('Upload exception: $e');
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

  // ===========================================================================
  // MEDIA-INGEST → INTERNAL DESCRIPTION (PHOTO/VIDEO)
  // ===========================================================================

  Future<String?> _describeMediaWithGemini({
    required File file,
    required String mimeType,
    required String mediaType,
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

      final desc = (data['description'] as String?) ??
          (data['caption'] as String?);

      return (desc?.trim().isEmpty ?? true) ? null : desc!.trim();
    } catch (e) {
      // ignore: avoid_print
      print('media-ingest error: $e');
      _showSnack('Failed to get AI description.');
      return null;
    }
  }

  // ===========================================================================
  // PHOTO UPLOAD
  // ===========================================================================

  Future<void> _onAddPhotoPressed() async {
    final picked = await _imagePicker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 90,
    );
    if (picked == null) return;

    final file = File(picked.path);
    final objectName =
        'photos/${DateTime.now().millisecondsSinceEpoch}_${picked.name}';

    try {
      final gcsUrl = await _uploadToGcs(
        file: file,
        objectName: objectName,
        contentType: 'image/jpeg',
      );

      if (gcsUrl == null) return;

      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: 'Photo uploaded.',
            isUser: true,
            createdAt: DateTime.now(),
            imageUrl: gcsUrl,
          ),
        );
      });
      _scrollToBottom();

      final desc = await _describeMediaWithGemini(
        file: file,
        mimeType: 'image/jpeg',
        mediaType: 'photo',
      );

      final targetLocale =
          _hasTargetLanguage ? _targetLocale! : _preferredLocale;

      final prompt = _isLanguageLearningMode
          ? '''
You are a patient language tutor.
Respond primarily in "$targetLocale" (the learner’s target language).

The learner has uploaded a photo.
Internal description (do NOT repeat verbatim to the learner):
${desc ?? "(No internal description available)"}.

RULES:
- The learner may use another language to talk about the photo or explain their goals.
- Do NOT correct that meta/explanatory language unless they explicitly ask you to.
- Focus on correcting and improving their attempts in the target language ("$targetLocale").

INSTRUCTIONS:
1) Briefly acknowledge the photo.
2) Ask them, in the target language, to describe the photo in a very simple sentence.
3) When they answer in the target language, you will gently correct and improve their sentences, and give short explanations if needed.

Keep this first reply short, friendly, and not like a legacy interview.
'''
          : '''
Respond ONLY in "$_preferredLocale" (the donor’s preferred language).

The donor uploaded a photo.
Internal description (do NOT repeat verbatim):
${desc ?? "(No internal description available)"}.

Warmly acknowledge receiving the photo, briefly mention what you understand,
and invite them to share the story or meaning behind it.
Keep your reply short and human.
''';

      final aiText = await _aiBrain.askBrain(
        message: prompt,
        mode: _mode,
        preferredLocale: _preferredLocale,
        targetLocale: _targetLocale,
        learningLevel: _learningLevel,
        conversationId: null,
      );
      _addAiMessageAndMaybeSpeak(aiText);
    } catch (e) {
      _showSnack('Photo upload failed: $e');
    }
  }

  // ===========================================================================
  // VIDEO UPLOAD
  // ===========================================================================

  Future<void> _onAddVideoPressed() async {
    final picked = await _imagePicker.pickVideo(source: ImageSource.gallery);
    if (picked == null) return;

    final file = File(picked.path);
    final objectName =
        'videos/${DateTime.now().millisecondsSinceEpoch}_${picked.name}';

    try {
      final gcsUrl = await _uploadToGcs(
        file: file,
        objectName: objectName,
        contentType: 'video/mp4',
      );

      if (gcsUrl == null) return;

      setState(() {
        _messages.add(
          _ChatMessage(
            id: UniqueKey().toString(),
            text: 'Video uploaded.',
            isUser: true,
            createdAt: DateTime.now(),
            videoUrl: gcsUrl,
          ),
        );
      });
      _scrollToBottom();

      final desc = await _describeMediaWithGemini(
        file: file,
        mimeType: 'video/mp4',
        mediaType: 'video',
      );

      final targetLocale =
          _hasTargetLanguage ? _targetLocale! : _preferredLocale;

      final prompt = _isLanguageLearningMode
          ? '''
You are a patient language tutor.
Respond primarily in "$targetLocale" (the learner’s target language).

The learner uploaded a short video.
Internal description (do NOT repeat verbatim to the learner):
${desc ?? "(No internal description available)"}.

RULES:
- The learner may use another language to talk about the video or explain their goals.
- Do NOT correct that meta/explanatory language unless they explicitly ask you to.
- Focus on correcting and improving their attempts in the target language ("$targetLocale").

INSTRUCTIONS:
1) Briefly acknowledge the video.
2) Ask them, in the target language, to describe what is happening in one or two very simple sentences.
3) When they answer in the target language, you will gently correct and improve their sentences, with short explanations if needed.

Keep this first reply short, friendly, and clearly focused on language practice, not a life-story interview.
'''
          : '''
Respond ONLY in "$_preferredLocale" (the donor’s preferred language).

The donor uploaded a short video.
Internal description (do NOT repeat verbatim):
${desc ?? "(No internal description available)"}.

Warmly acknowledge the video, mention what you infer in broad strokes,
and invite the donor to talk about the story, context, or meaning.
Keep it short and conversational.
''';

      final aiText = await _aiBrain.askBrain(
        message: prompt,
        mode: _mode,
        preferredLocale: _preferredLocale,
        targetLocale: _targetLocale,
        learningLevel: _learningLevel,
        conversationId: null,
      );
      _addAiMessageAndMaybeSpeak(aiText);
    } catch (e) {
      _showSnack('Video upload failed: $e');
    }
  }

  // ===========================================================================
  // UI BUILD
  // ===========================================================================

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Legacy'),
        actions: [
          // Conversation mode toggle: legacy vs language learning
          IconButton(
            icon: Icon(
              _isLanguageLearningMode
                  ? Icons.translate
                  : Icons.auto_stories,
            ),
            tooltip: _isLanguageLearningMode
                ? 'Switch to legacy storytelling mode'
                : 'Switch to language learning mode',
            onPressed: _toggleConversationMode,
          ),

          // Voice mode toggle: chatbot vs silent
          IconButton(
            icon: Icon(
              _isChatbotMode ? Icons.volume_up : Icons.volume_off,
            ),
            tooltip: _isChatbotMode
                ? 'Switch to silent mode'
                : 'Switch to chatbot mode (auto voice)',
            onPressed: _toggleVoiceMode,
          ),
          IconButton(
            icon: Icon(_micEnabled ? Icons.mic : Icons.mic_off),
            tooltip: _micEnabled ? 'Disable microphone' : 'Enable microphone',
            onPressed: _toggleMicEnabled,
          ),
          IconButton(
            icon: const Icon(Icons.record_voice_over),
            tooltip: 'Change AI voice',
            onPressed: _showVoicePicker,
          ),

          // Language-learning settings
          IconButton(
            icon: const Icon(Icons.school),
            tooltip: 'Language learning settings',
            onPressed: _showLanguageLearningSettingsSheet,
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
            Text('You can:', style: TextStyle(fontSize: 14)),
            SizedBox(height: 8),
            Text('• Continue your legacy interview',
                style: TextStyle(fontSize: 14)),
            Text('• Tell a story about something that happened today',
                style: TextStyle(fontSize: 14)),
            Text("• Vent about something that's bothering you",
                style: TextStyle(fontSize: 14)),
            Text('• Share a memory from childhood',
                style: TextStyle(fontSize: 14)),
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
      itemBuilder: (context, i) {
        final msg = _messages[i];
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
                // IMAGE
                if (msg.imageUrl != null) ...[
                  GestureDetector(
                    onTap: () {
                      showDialog(
                        context: context,
                        builder: (_) => Dialog(
                          child: InteractiveViewer(
                            child: Image.network(
                              msg.imageUrl!,
                              fit: BoxFit.contain,
                            ),
                          ),
                        ),
                      );
                    },
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.network(
                        msg.imageUrl!,
                        height: 200,
                        width: 200,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => const SizedBox(
                          height: 80,
                          child: Center(
                            child: Text('Image failed to load'),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],

                // VIDEO
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

                // TEXT + speaker
                if (msg.text.isNotEmpty)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Text(
                          msg.text,
                          style: TextStyle(color: textColor),
                        ),
                      ),
                      if (!isUser)
                        IconButton(
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(),
                          icon: Icon(
                            Icons.volume_up,
                            size: 18,
                            color: textColor.withOpacity(0.9),
                          ),
                          tooltip: 'Play this message',
                          onPressed: () => _playTtsForMessage(msg),
                        ),
                    ],
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
      color:
          Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.4),
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

  Widget _buildSpeakingModeChip(ThemeData theme) {
    // Only show if we actually have a target language configured
    if (!_hasTargetLanguage) {
      return const SizedBox.shrink();
    }

    final isNative = _isSpeakingNative;
    final label = isNative ? 'Speaking: Native' : 'Speaking: Target';

    return InkWell(
      onTap: () {
        setState(() {
          if (_speakingMode == 'native') {
            _speakingMode = 'target';
            if (_targetLocale != null) {
              _sttLanguageCode = _targetLocale!;
            }
          } else {
            _speakingMode = 'native';
            _sttLanguageCode = _preferredLocale;
          }
        });

        _showSnack(
          _speakingMode == 'native'
              ? 'Mic will listen in your native language.'
              : 'Mic will listen in the language you are learning.',
        );
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        margin: const EdgeInsets.only(right: 4),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceVariant.withOpacity(0.7),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            color: theme.colorScheme.onSurface.withOpacity(0.8),
          ),
        ),
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

            // Speaking mode chip (Native / Target)
            _buildSpeakingModeChip(theme),

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

// ============================================================================
// FULL-SCREEN VIDEO PLAYER
// ============================================================================

class VideoPlayerScreen extends StatefulWidget {
  final String videoUrl;

  const VideoPlayerScreen({super.key, required this.videoUrl});

  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  late VideoPlayerController _controller;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _controller = VideoPlayerController.network(widget.videoUrl)
      ..initialize().then((_) {
        if (!mounted) return;
        setState(() => _ready = true);
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
        child: _ready
            ? AspectRatio(
                aspectRatio: _controller.value.aspectRatio,
                child: VideoPlayer(_controller),
              )
            : const CircularProgressIndicator(),
      ),
      floatingActionButton: _ready
          ? FloatingActionButton(
              onPressed: () {
                setState(() {
                  _controller.value.isPlaying
                      ? _controller.pause()
                      : _controller.play();
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
