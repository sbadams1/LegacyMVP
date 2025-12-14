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
import 'dart:typed_data';

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
import 'story_library_screen.dart';

enum _TutorQuickAction {
  showProgress,
  advance,
  goBack,
  pronunciationDrill,
  reviewLesson,
  redoLesson,
}

enum _ConversationModeChoice {
  legacy,
  languageLearning,
  avatar,
}

enum _MainMenuAction {
  storyLibrary,
  avatarMode,
  languageLearningSettings,
  coverage,        // coverage map screen
  settings,
  endSession,      // NEW: trigger end-session + heavy processing
}

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

  // JSON state 
  String? _legacyStateJson;         // for mode = legacy
  String? _languageStateJson;       // for mode = language_learning

  /// Current conversation session id from the ai-brain backend.
  /// This is sent back on each turn so the backend can summarise
  /// the correct session when we trigger an end-session.
  String? _conversationId;

  // Recorder
  final FlutterSoundRecorder _recorder = FlutterSoundRecorder();
  bool _recorderInited = false;
  bool _isRecording = false;
  bool _isTranscribing = false; // NEW: show spinner while STT is running

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

  // ---------------------------------------------------------------------------
  // LOCAL TTS CONFIG
  // ---------------------------------------------------------------------------

  // Local TTS (on-device, no Supabase TTS function)
  final FlutterTts _tts = FlutterTts();

  // These store the *last used* language codes (for logging / debugging / compatibility).
  String _ttsLanguageCode = 'en-US';
  String _sttLanguageCode = 'en-US';

  /// Effective L1 ("native") language based on resolved preferences.
  /// This is language-agnostic: any valid locale (e.g. "es-ES", "ja-JP") works.
  String get _currentL1 => _preferredLocale;

  /// Effective L2 ("target") language based on resolved preferences.
  /// If no distinct target language is set, this simply falls back to L1.
  String get _currentL2 {
    if (_targetLocale != null && _targetLocale!.isNotEmpty) {
      return _targetLocale!;
    }
    return _preferredLocale;
  }

  // Global speed factor for TTS. 1.0 = normal, <1 slower, >1 faster.
  double _ttsRateFactor = 0.7; // start a bit slower so it doesn't sound rushed

  // ---------------------------------------------------------------------------
  // TTS language helpers (Thai detection, segmentation, cleanup)
  // ---------------------------------------------------------------------------

  // Thai script detection for segmentation and other helpers.
  final RegExp _thaiCharRegex = RegExp(r'[\u0E00-\u0E7F]');

  // Rough segmentation into "Thai" vs "Latin-ish" chunks so we can switch
  // languages cleanly for TTS when older code paths call this helper.
  final RegExp _languageSegmentRegex = RegExp(
    r"[\u0E00-\u0E7F]+|[A-Za-z0-9' \n\r\t\.,;:!\?()\-_/]+",
  );

  String _detectLangForSegment(String text) {
    final hasThai = _thaiCharRegex.hasMatch(text);

    final target = _targetLocale?.toLowerCase() ?? '';
    final pref = _preferredLocale.toLowerCase();
    final targetIsThai = target.startsWith('th');
    final prefIsThai = pref.startsWith('th');

    // 1) If the segment actually contains Thai script, always choose
    //    whichever configured locale is Thai (L1 or L2).
    if (hasThai) {
      if (prefIsThai) return _preferredLocale;
      if (targetIsThai) return _targetLocale ?? _preferredLocale;
    }

    // 2) No Thai script at all:
    //    - If exactly one of the locales is Thai, then this segment
    //      almost certainly belongs to the *other* (non-Thai) locale.
    final bool exactlyOneThai = prefIsThai ^ targetIsThai;

    if (exactlyOneThai) {
      // If preferred is Thai and target is not, use target (e.g. L1=th, L2=en).
      if (prefIsThai && !targetIsThai && _targetLocale != null) {
        return _targetLocale!;
      }
      // If target is Thai and preferred is not, use preferred (e.g. L1=en, L2=th).
      if (targetIsThai && !prefIsThai) {
        return _preferredLocale;
      }
    }

    // 3) Fallback: no Thai in either locale or they are both non-Thai.
    //    Default to the preferred/native language.
    return _preferredLocale;
  }

  /// Detects Thai combining marks (vowel/tone marks without a base consonant).
  /// If a token starts with one of these, it's usually a broken fragment like "ือ"
  /// that we don't want to send to TTS.
  bool _isThaiCombiningMark(int codePoint) {
    // Thai combining marks range: U+0E30–U+0E3A and U+0E47–U+0E4E (roughly).
    return (codePoint >= 0x0E30 && codePoint <= 0x0E3A) ||
        (codePoint >= 0x0E47 && codePoint <= 0x0E4E);
  }

  /// Cleans Thai text before sending it to the TTS engine:
  ///  - Keeps only Thai characters, whitespace, and basic punctuation
  ///  - Drops tokens that are obviously broken (start with combining marks, too short)
  String _cleanupThaiForTts(String input) {
    if (input.trim().isEmpty) return '';

    // 1) Keep only Thai chars, whitespace, and basic punctuation
    final filtered = input.replaceAll(
      RegExp(r'[^\u0E00-\u0E7F\s\?\!\.,]'),
      '',
    );

    // 2) Tokenize by whitespace
    final tokens = filtered.split(RegExp(r'\s+'));

    // 3) Drop obviously broken or tiny tokens (like orphan "ื" or "ือ")
    final cleanedTokens = tokens.where((t) {
      final runes = t.runes.toList();
      if (runes.isEmpty) return false;
      // If the first code point is a combining mark, this is probably garbage
      if (_isThaiCombiningMark(runes.first)) return false;
      // Too short → usually garbage
      if (runes.length < 2) return false;
      return true;
    }).toList();

    // 4) Rejoin and trim
    return cleanedTokens.join(' ').trim();
  }

  // (rest of your class stays exactly as-is: _speakTextWithAutoLanguage, initState, build, etc.)

  /// Legacy helper: speak text by auto-detecting L1 vs L2 from Thai/Latin script.
  /// Newer code paths use explicit [L1]/[L2] segments, but we keep this as a
  /// compatibility layer for any older callers.
  Future<void> _speakTextWithAutoLanguage(String text) async {
    if (text.trim().isEmpty) return;

    await _tts.awaitSpeakCompletion(true);

    final matches = _languageSegmentRegex.allMatches(text);

    for (final match in matches) {
      var segment = match.group(0)?.trim() ?? '';
      if (segment.isEmpty) continue;

      final langCode = _detectLangForSegment(segment);

      // Only apply Thai cleanup when the segment is actually in Thai.
      if (langCode.toLowerCase().startsWith('th')) {
        segment = _cleanupThaiForTts(segment);
        if (segment.isEmpty) continue;
      }

      await _tts.setLanguage(langCode);
      await _tts.speak(segment);

      // Tiny pause (~50ms) between segments so language switches feel natural
      await Future.delayed(const Duration(milliseconds: 50));
    }
  }
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

  void _showModePicker() async {
    final currentMode = _mode; // "legacy", "language_learning", "avatar"

    final result = await showModalBottomSheet<_ConversationModeChoice>(
      context: context,
      showDragHandle: true,
      builder: (context) {
        _ConversationModeChoice? selected;
        if (currentMode == 'language_learning') {
          selected = _ConversationModeChoice.languageLearning;
        } else if (currentMode == 'avatar') {
          selected = _ConversationModeChoice.avatar;
        } else {
          selected = _ConversationModeChoice.legacy;
        }

        Widget buildTile(
          _ConversationModeChoice choice,
          String title,
          String subtitle,
          IconData icon,
        ) {
          final isSelected = selected == choice;
          return ListTile(
            leading: Icon(icon),
            title: Text(title),
            subtitle: Text(subtitle),
            trailing: isSelected ? const Icon(Icons.check) : null,
            onTap: () {
              Navigator.of(context).pop(choice);
            },
          );
        }

        // Safely derive a label for the L2 we’re practicing.
        // If _targetLocale is null/empty, fall back to a generic label.
        final l2Label =
            (_targetLocale == null || _targetLocale!.trim().isEmpty)
                ? 'TARGET LANGUAGE'
                : _targetLocale!.toUpperCase();

        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  'Choose conversation mode',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
              ),
              buildTile(
                _ConversationModeChoice.legacy,
                'Legacy storytelling',
                'Capture memories and life stories',
                Icons.auto_stories,
              ),
              buildTile(
                _ConversationModeChoice.languageLearning,
                'Language learning',
                'Practice $l2Label with guided lessons',
                Icons.translate,
              ),
              buildTile(
                _ConversationModeChoice.avatar,
                'Avatar (answer as me)',
                'AI answers in your voice, based on recorded memories',
                Icons.person,
              ),
              const SizedBox(height: 16),
            ],
          ),
        );
      },
    );

    if (result == null) return;

    setState(() {
      switch (result) {
        case _ConversationModeChoice.legacy:
          _mode = 'legacy';
          break;
        case _ConversationModeChoice.languageLearning:
          _mode = 'language_learning';
          break;
        case _ConversationModeChoice.avatar:
          _mode = 'avatar';
          break;
      }
    });

    _showSnack(
      _mode == 'legacy'
          ? 'Legacy storytelling mode'
          : _mode == 'language_learning'
              ? 'Language learning mode'
              : 'Avatar mode (answering as you)',
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

    String? prefRaw;   // L1, from Supabase profiles.preferred_language
    String? targetRaw; // L2, from Supabase supported_languages[0] or local override
    String? levelRaw;  // learning level, local only

    // ------------------------------------------------------------------
    // 1) LOCAL: Only treat target + level as overrides
    //    We no longer trust preferred_locale in SharedPreferences.
    // ------------------------------------------------------------------
    try {
      final prefs = await SharedPreferences.getInstance();
      targetRaw = prefs.getString('target_locale');
      levelRaw = prefs.getString('learning_level');
    } catch (e) {
      // ignore: avoid_print
      print('Failed to load language prefs from SharedPreferences: $e');
    }

    // ------------------------------------------------------------------
    // 2) SERVER: profiles is the source of truth for L1 (and default L2)
    // ------------------------------------------------------------------
    try {
      final data = await _client
          .from('profiles')
          .select('preferred_language, supported_languages')
          .eq('id', user.id)
          .limit(1)
          .maybeSingle();

      if (data != null && data is Map<String, dynamic>) {
        final dbPref = (data['preferred_language'] as String?)?.trim();
        if (dbPref != null && dbPref.isNotEmpty) {
          prefRaw = dbPref;
        }

        // If no explicit local target override, use first supported language.
        if ((targetRaw == null || targetRaw.trim().isEmpty) &&
            data['supported_languages'] is List) {
          final list = (data['supported_languages'] as List)
              .whereType<String>()
              .map((s) => s.trim())
              .where((s) => s.isNotEmpty)
              .toList();
          if (list.isNotEmpty) {
            targetRaw = list.first;
          }
        }
      }
    } catch (e, st) {
      // ignore: avoid_print
      print('Failed to load language prefs from DB: $e');
      // ignore: avoid_print
      print(st);
    }

    // ------------------------------------------------------------------
    // 3) Apply defaults + normalize
    // ------------------------------------------------------------------
    final resolvedPref = _normalizeLocale(prefRaw ?? 'en-US');
    final resolvedTarget = (targetRaw == null || targetRaw.isEmpty)
        ? null
        : _normalizeLocale(targetRaw);

    if (!mounted) return;
    setState(() {
      _preferredLocale = resolvedPref;   // L1 (always from DB)
      _targetLocale = resolvedTarget;    // L2 (DB default + optional local override)
      _learningLevel =
          (levelRaw == null || levelRaw.isEmpty) ? null : levelRaw;

      // Default STT language: native/preferred language (L1)
      _speakingMode = 'native';
      _sttLanguageCode = _preferredLocale;

      // Keep TTS aligned with the preferred/native language by default.
      _ttsLanguageCode = _preferredLocale;
    });

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

  Future<void> _handleEndSessionPressed() async {
    if (_isSending) return;

    // For now, we only support explicit end-session for legacy interviews.
    if (_mode != 'legacy') {
      _showSnack('End session is only available in Legacy mode for now.');
      return;
    }

    if (_conversationId == null) {
      _showSnack('No active legacy session to end yet.');
      return;
    }

    await _sendTextMessage(
      '__END_SESSION__', // non-empty so ai-brain never rejects it
      showUserBubble: false,
      endSession: true,
    );

    _showSnack('Ending session and rebuilding coverage/insights...');
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

  Future<void> _waitForTtsDone() async {
    bool speaking = true;

    _tts.setCompletionHandler(() {
      speaking = false;
    });

    _tts.setErrorHandler((_) {
      speaking = false;
    });

    while (speaking) {
      await Future.delayed(const Duration(milliseconds: 150));
    }
  }

  String _cleanForTts(String text) {
    // Remove markup-style characters that add no spoken value.
    // Examples: *bold*, _italics_, ~~strikethrough~~, `code`
    var cleaned = text;

    // Strip asterisks, underscores, tildes, backticks
    cleaned = cleaned.replaceAll(RegExp(r'[*_~`]+'), '');

    // Collapse multiple spaces that might be left behind
    cleaned = cleaned.replaceAll(RegExp(r'\s{2,}'), ' ');

    return cleaned.trim();
  }

    /// For L1 segments when L2 is Thai:
    /// - Remove any Thai script so the L1 voice never tries to pronounce Thai.
    /// - Keep everything else (English, punctuation, etc.) intact.
    /// This is scoped to Thai only so it won't affect other L2 languages.
  String _stripTargetScriptFromL1(String text) {
    if (text.isEmpty) return text;
    if (_targetLocale == null) return text;

    final target = _targetLocale!.toLowerCase();

    // Only apply this logic when L2 is Thai.
    if (!target.startsWith('th')) {
      return text;
    }

    final buffer = StringBuffer();
      for (final rune in text.runes) {
      final ch = String.fromCharCode(rune);
      // Drop Thai characters; keep everything else.
      if (!_thaiCharRegex.hasMatch(ch)) {
        buffer.write(ch);
      }
    }

    var cleaned = buffer.toString();
    cleaned = cleaned.replaceAll(RegExp(r'\s{2,}'), ' ');
    return cleaned.trim();
  }

// ===========================================================================
// TTS CLEANUP: strip / rewrite Thai polite particles from L1 text
// so the English voice doesn't hit silent gaps or broken sentences.
// ===========================================================================
// ===========================================================================
// TTS CLEANUP: gently strip / rewrite Thai romanization from L1 text
// so the English voice doesn't hit silent gaps or broken sentences.
// This version is intentionally conservative: it only touches parentheses,
// never raw quotes.
// ===========================================================================
// ===========================================================================
// TTS CLEANUP: gently strip / rewrite Thai romanization from L1 text
// so the English voice doesn't hit silent gaps or broken sentences.
// This version is intentionally conservative.
// ===========================================================================
String _stripThaiRomanizationFromL1(String text) {
  if (text.isEmpty) return text;

  var cleaned = text;

  // 1) Replace polite particles in parentheses with a generic phrase.
  //    Example:
  //    "Say it with (kha)." → "Say it with the polite ending."
  final politeParenPattern = RegExp(
    r'\((kha|ka|khrap|krap|khaa|khá|khâ|ká|kâ)\)',
    caseSensitive: false,
  );
  cleaned = cleaned.replaceAll(politeParenPattern, ' the polite ending');

  // 2) Replace parenthesized chunks that clearly look like Thai romanization
  //    with a generic phrase.
  //    Example:
  //    "you said (sa-baii dii mai kha)" → "you said the Thai phrase"
  final romanParenPattern = RegExp(
    r'\(([^\)]*)\)',
    caseSensitive: false,
  );

  cleaned = cleaned.replaceAllMapped(romanParenPattern, (m) {
    final inner = m.group(1)!.trim().toLowerCase();

    // Tokens we consider typical Thai romanization.
    final looksThai = RegExp(
      r'\b(ka|kha|khrap|krap|sawasdee|sawatd(i|ee)|sawadee|sa[-\s]?baai|sabai|khun|mai)\b',
    ).hasMatch(inner);

    if (looksThai) {
      return ' the Thai phrase ';
    }

    // Otherwise, leave the parentheses as-is (might be real English text).
    return m.group(0)!;
  });

  // 3) If, after this process, we still have empty quotes like "",
  //    replace them with a sensible placeholder so TTS doesn't skip them.
  //    Example:
  //    '"" is close, but...' → 'That phrase is close, but...'
  cleaned = cleaned.replaceAll('""', 'that phrase');

  // 4) Collapse multiple spaces and trim.
  cleaned = cleaned.replaceAll(RegExp(r'\s{2,}'), ' ');
  return cleaned.trim();
}

  /// Split an [L1] line into two pieces:
  /// - pure L1 text (no Thai script)
  /// - pure L2 script (currently only Thai), so it can be spoken by the L2 voice.
  Map<String, String> _splitL1AndTargetScript(String text) {
    if (text.isEmpty) {
      return {'l1': '', 'l2': ''};
    }

    // If there is no L2 / no Thai, just keep everything as L1.
    if (_targetLocale == null || !_targetLocale!.toLowerCase().startsWith('th')) {
      return {'l1': text.trim(), 'l2': ''};
    }

    final l1Buf = StringBuffer();
    final l2Buf = StringBuffer();

    for (final rune in text.runes) {
      final ch = String.fromCharCode(rune);

      // Thai characters → L2 bucket; everything else → L1 bucket.
      if (_thaiCharRegex.hasMatch(ch)) {
        l2Buf.write(ch);
      } else {
        l1Buf.write(ch);
      }
    }

    final l1Text =
        l1Buf.toString().replaceAll(RegExp(r'\s{2,}'), ' ').trim();
    final l2Text =
        l2Buf.toString().replaceAll(RegExp(r'\s{2,}'), ' ').trim();

    return {'l1': l1Text, 'l2': l2Text};
  }

/// Remove any (...) group that does NOT contain Thai characters.
/// This catches romanization or explanatory parentheses so they are
/// never spoken aloud. Parentheses that contain Thai are kept.
String _stripRomanizationParens(String text) {
  if (text.isEmpty) return text;

  final parenRegex = RegExp(r'\(([^)]*)\)');

  final cleaned = text.replaceAllMapped(parenRegex, (match) {
    final inside = match.group(1) ?? '';
    // If the inside has Thai script, keep the whole "(...)"
    if (_thaiCharRegex.hasMatch(inside)) {
      return match.group(0)!;
    }
    // Otherwise, drop this parenthetical entirely.
    return '';
  });

  return cleaned.replaceAll(RegExp(r'\s{2,}'), ' ').trim();
}

  // ===========================================================================
  // TTS CLEANUP: strip trailing non-Thai parenthetical hints (e.g. "(û ì á)")
  // ===========================================================================
  String _stripTrailingToneMarker(String text) {
  // Look for a trailing " ( ... )" at the END of the string.
  final trailingParenRegex = RegExp(r'\s*\(([^)]*)\)\s*$');
  final match = trailingParenRegex.firstMatch(text);
  if (match == null) {
    return text;
  }
  final inside = match.group(1) ?? '';
  final hasThai = RegExp(r'[\u0E00-\u0E7F]').hasMatch(inside);
  if (hasThai) {
    return text;
  }
  // Otherwise, strip the entire parenthetical chunk at the end.
  final cleaned = text.replaceRange(match.start, text.length, '').trimRight();
  return cleaned;
  }

  // ===========================================================================
  // Strip JSON-ish trailing junk (quotes/commas/brackets) from a segment
  // ===========================================================================
  String _stripJsonLikeTrailingJunk(String text) {
  var out = text.trimRight();

  // Remove trailing ", "" or ", or stray ] at the end of the string.
  // Example:  สวัสดีครับ (-- á)", ""
  out = out.replaceAll(RegExp(r'["\],]+$'), '').trimRight();

  return out;
  }

  // ===========================================================================
  // Decide if a Thai segment is just a helper/romanization blob to skip
  //   e.g. "(û ì á)" or "(â â ò â á á/â â û í ือ à-)"
  // ===========================================================================
  bool _shouldSkipThaiHelperSegment(String text) {
  final trimmed = text.trimLeft();

  // If it doesn't even start with a parenthesis, it's probably a real phrase.
  if (!trimmed.startsWith('(')) return false;

  final thaiRegex = RegExp(r'[\u0E00-\u0E7F]');
  final letterRegex = RegExp(r'[A-Za-z\u0E00-\u0E7F]');

  final thaiCount = thaiRegex.allMatches(text).length;
  final letterCount = letterRegex.allMatches(text).length;

  if (letterCount == 0) return false;

  final ratio = thaiCount / letterCount;

  // If fewer than ~50% of the characters are Thai, treat it as a helper blob.
  return ratio < 0.5;
  }

  Future<void> _playTtsForMessage(_ChatMessage msg) async {
  // Respect global voice mode: no TTS in silent mode.
  if (_voiceMode == 'silent') {
    return;
  }

  final raw = msg.text.trim();
  if (raw.isEmpty) return;

    // Clean markup/asterisks/backticks so they are never spoken.
    final sanitizedRaw = _cleanForTts(raw);
    if (sanitizedRaw.isEmpty) return;

    // We want to parse sequences like:
    // [L1] English text...
    // [L2] Thai text...
    // [en-US] more English...
    //
    // So we scan the whole string for [TAG] and grab the text that follows each
    // tag up to the next tag.
    final List<Map<String, String>> segments = [];
    final segmentRegex = RegExp(r'\[([^\]]+)\]\s*([^[]*)');
    final matches = segmentRegex.allMatches(sanitizedRaw);

    // If there are NO [L1]/[L2]/[xx-YY] tags at all, fall back to the simpler
    // auto language splitter so the message is never completely silent.
    if (matches.isEmpty) {
      debugPrint(
          '🔊 No explicit tags found in reply; falling back to auto L1/L2 segmentation.');
      await _speakTextWithAutoLanguage(sanitizedRaw);
      return;
    }

    // ------------------------------------------------------------------------
    // BUILD SEGMENTS
    // ------------------------------------------------------------------------
    for (final m in matches) {
      final tag = (m.group(1) ?? '').trim();
      final textPart = _cleanForTts((m.group(2) ?? ''));
      if (textPart.isEmpty) continue;

      final upper = tag.toUpperCase();

      // 🔹 SPECIAL CASE: [L1] lines may contain Thai script mixed in.
      // For TTS, we split that into:
      //   - a pure L1 segment (spoken with the L1 voice)
      //   - a pure L2 segment (spoken with the L2 voice)
      if (upper == 'L1') {
        final parts = _splitL1AndTargetScript(textPart);
        var l1Text = (parts['l1'] ?? '').trim();
        final l2Text = (parts['l2'] ?? '').trim();

        // Extra guard: remove Thai polite particles written in Latin letters
        // from L1 text so the L1 voice doesn't hit awkward silences.
        l1Text = _stripThaiRomanizationFromL1(l1Text);

        if (l1Text.isNotEmpty) {
          segments.add({
            'lang': _preferredLocale,
            'text': l1Text,
          });
        }

        if (l2Text.isNotEmpty) {
          String l2Lang = _preferredLocale;
          if (_hasTargetLanguage &&
              _targetLocale != null &&
              _targetLocale!.trim().isNotEmpty) {
            l2Lang = _targetLocale!;
          }
          segments.add({
            'lang': l2Lang,
            'text': l2Text,
          });
        }

        // We’ve fully handled this [L1] line; move on.
        continue;
      }

      // Normal handling for [L2] or explicit locale tags.
      String effectiveLang = _preferredLocale;

      if (upper == 'L2') {
        // L2 = target locale if available, else fall back to preferred
        if (_hasTargetLanguage &&
            _targetLocale != null &&
            _targetLocale!.trim().isNotEmpty) {
          effectiveLang = _targetLocale!;
        } else {
          effectiveLang = _preferredLocale;
        }
      } else {
        // Assume locale-style tag, e.g. [en-US], [th-TH]
        effectiveLang = tag;
      }

      // 🔹 NEW: If this segment is effectively "native" (L1) but contains Thai,
      // split it the same way as [L1] so that Thai never shares the same
      // segment as English.
      final bool isNativeLang = (effectiveLang == _preferredLocale);
      final bool hasThai = _thaiCharRegex.hasMatch(textPart);
      final bool isThaiTarget =
          _hasTargetLanguage &&
          _targetLocale != null &&
          _targetLocale!.toLowerCase().startsWith('th');

      if (isNativeLang && isThaiTarget && hasThai) {
        final parts = _splitL1AndTargetScript(textPart);
        final l1Text = (parts['l1'] ?? '').trim();
        final l2Text = (parts['l2'] ?? '').trim();

        if (l1Text.isNotEmpty) {
          segments.add({
            'lang': _preferredLocale,
            'text': l1Text,
          });
        }

        if (l2Text.isNotEmpty) {
          segments.add({
            'lang': _targetLocale!,
            'text': l2Text,
          });
        }

        // We’ve re-routed this combined segment into separate L1/L2 segments.
        continue;
      }

      // Default: just use the effective language as-is.
      segments.add({
        'lang': effectiveLang,
        'text': textPart,
      });
    }

    if (segments.isEmpty) {
      debugPrint('🔇 No TTS segments found after parsing tags.');
      return;
    }

    // ------------------------------------------------------------------------
    // PLAY SEGMENTS
    // ------------------------------------------------------------------------
    try {
      for (final seg in segments) {
        final lang = seg['lang'] ?? _preferredLocale;
        var text = seg['text'] ?? '';
        text = text.trim();
        if (text.isEmpty) continue;

        // Never speak romanization-style parentheses.
        text = _stripRomanizationParens(text);
        if (text.isEmpty) {
          debugPrint(
              '🔊 Segment empty after stripping romanization; skipping.');
          continue;
        }

        /// For L2 Thai segments:
        /// - If there is no Thai script at all, treat it as pure romanization and drop it.
        /// - Otherwise, strip all Latin letters so only Thai script and punctuation remain.
        String _stripThaiRomanization(String text) {
          if (text.isEmpty) return text;

          // If there's NO Thai at all → pure romanization → drop entire segment.
          if (!_thaiCharRegex.hasMatch(text)) {
            return '';
          }

          final buffer = StringBuffer();

          for (final rune in text.runes) {
            final ch = String.fromCharCode(rune);

            final bool isThai = _thaiCharRegex.hasMatch(ch);
            final bool isAllowedPunctuation =
                RegExp(r'[.,!?…\s/]').hasMatch(ch);

            if (isThai || isAllowedPunctuation) {
              buffer.write(ch);
            }
          }

          var cleaned = buffer.toString();
          cleaned = cleaned.replaceAll(RegExp(r'\s{2,}'), ' ');
          return cleaned.trim();
        }

        // If this is an L2 Thai segment, strip all Latin letters so we speak
        // only Thai script and punctuation.
        final bool isThaiL2 =
            _targetLocale != null &&
            lang == _targetLocale &&
            _targetLocale!.toLowerCase().startsWith('th');

        if (isThaiL2) {
          final strippedThai = _stripThaiRomanization(text);
          if (strippedThai.isEmpty) {
            debugPrint(
                '🔊 L2 Thai segment empty after stripping romanization; skipping.');
            continue;
          }
          text = strippedThai;
        }

        debugPrint('🔊 TTS segment → lang=$lang text="$text"');

        // Configure TTS for this segment
        try {
          await _tts.setLanguage(lang);
        } catch (e) {
          debugPrint('TTS setLanguage error ($lang): $e');
        }

        // Use your current voice settings
        try {
          final v = _currentVoice;
          if (Platform.isAndroid) {
            await _tts.setSpeechRate(v.rateAndroid);
          } else if (Platform.isIOS) {
            await _tts.setSpeechRate(v.rateIOS);
          }
          await _tts.setPitch(v.pitch);
        } catch (e) {
          debugPrint('TTS voice config error: $e');
        }

        // Speak this segment and wait for it to finish
        await _tts.stop();
        await _tts.speak(text);
        await _waitForTtsDone();

        // Short pause between segments
        await Future.delayed(const Duration(milliseconds: 150));
      }
    } catch (e) {
      debugPrint('TTS error: $e');
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

  void _activateAvatarMode() {
    setState(() {
      // Avatar is a third mode that shares the legacy state_json
      // but uses the avatar system prompt in ai-brain.
      _mode = 'avatar';
    });

    _showSnack(
      'Avatar mode: the AI will now answer as your future self using your recorded memories.',
    );
  }

  void _openCoverageScreen() {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => const CoverageScreen(),
      ),
    );
  }

  void _handleMainMenuAction(_MainMenuAction action) {
    switch (action) {
      case _MainMenuAction.storyLibrary:
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => const StoryLibraryScreen(),
          ),
        );
        break;

      case _MainMenuAction.avatarMode:
        _activateAvatarMode();
        break;

      case _MainMenuAction.languageLearningSettings:
        _showLanguageLearningSettingsSheet();
        break;

      case _MainMenuAction.coverage:
        _openCoverageScreen();
        break;

      case _MainMenuAction.settings:
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => const SettingsScreen(),
          ),
        );
        break;

      case _MainMenuAction.endSession:
        _handleEndSessionPressed();
        break;
    }
  }

  // ===========================================================================
  // MODE-AWARE PROMPT WRAPPER (DISABLED — raw passthrough)
  // ===========================================================================

  String _buildModeWrappedPrompt(String userMessage) {
  // We no longer construct any AI prompts on the Flutter side.
  // The ai-brain/index.ts function now handles ALL mode-aware prompting,
  // user modeling, [L1]/[L2] tagging expectations, and lesson flow logic.
  //
  // Flutter now simply forwards the raw user message exactly as typed.
  return userMessage;
  }

  Map<String, dynamic> _buildConversationStateModel() {
  final effectiveTargetLocale =
      _hasTargetLanguage ? _targetLocale : _preferredLocale;

  final map = <String, dynamic>{
    'mode': _mode,
    'voice_mode': _voiceMode,
    'preferred_locale': _preferredLocale,
    'target_locale': effectiveTargetLocale,
    'has_target_language': _hasTargetLanguage,
    'learning_level': _learningLevel,
    'speaking_mode': _speakingMode,
    'stt_language_code': _sttLanguageCode,
    'tts_rate_factor': _ttsRateFactor,

    // ── NEW: high-level “curriculum” hints ──────────────────────────────
    if (_mode == 'legacy') ...{
      'legacy_focus_chapter': 'childhood',
      'legacy_focus_subtopics': [
        'family',
        'home environment',
        'early school',
        'friends',
        'neighborhood',
        'earliest memories',
      ],
      'legacy_goal': 'help the donor share concrete childhood memories with feelings, not just facts, without repeating the same question style over and over.',
    },

    if (_mode == 'language_learning') ...{
      'language_unit': 'S1_GREETINGS',
      'language_unit_title': 'Basic greetings and introductions',
      'language_unit_goal':
          'by the end of this unit the learner can greet, say their name, ask and answer where they are from, ask and answer how they are, and close politely in the target language.',
    },
  };

  map.removeWhere((key, value) => value == null);
  return map;
  }

  String _buildStateJson() {
    try {
      final model = _buildConversationStateModel();
      return jsonEncode(model);
    } catch (e) {
      // ignore: avoid_print
      print('Failed to serialize state_json: $e');
      return '{}';
    }
  }

  // ===========================================================================
  // TEXT → AI BRAIN
  // ===========================================================================

  void _handleSendPressed() async {
    final text = _textController.text.trim();
    _textController.clear();
    if (text.isEmpty) return;

    // For typed text, we always show the user's bubble immediately.
    await _sendTextMessage(text, showUserBubble: true);
  }

  Future<void> _sendMetaCommand(String command) async {
    // Reuse the normal send pipeline, but we can keep this as a separate
    // helper in case we ever want to treat meta-commands differently.
    await _sendTextMessage(command, showUserBubble: true);
  }

  Future<void> _sendTextMessage(
    String text, {
    bool showUserBubble = true,
    bool endSession = false,
  }) async {
    if (_isSending) return;

    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in.');
      return;
    }

    String trimmed = text.trim();

    // Allow empty text only when we're explicitly ending the session.
    if (!endSession && trimmed.isEmpty) return;

    // Backend requires message_text to be present; for end-session,
    // send a tiny placeholder but don't show a user bubble.
    if (endSession && trimmed.isEmpty) {
      trimmed = '__END_SESSION__';
    }

    if (showUserBubble && trimmed.isNotEmpty) {
      // Normal typed message: add user bubble with their actual text.
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

    setState(() => _isSending = true);

    try {
      final wrapped = _buildModeWrappedPrompt(trimmed);

      final result = await _aiBrain.askBrain(
        message: wrapped,
        mode: _mode,
        preferredLocale: _preferredLocale,
        targetLocale: _targetLocale,
        learningLevel: _learningLevel,

        // ✅ keep the same session across turns
        conversationId: _conversationId,

        stateJson:
          _mode == 'language_learning' ? _languageStateJson : _legacyStateJson,
      );

      final convId = result['conversation_id'] as String?;
      if (convId != null && convId.isNotEmpty) {
        if (mounted) {
          setState(() {
            _conversationId = convId;
          });
        } else {
          _conversationId = convId;
        }
      }

      var aiText = (result['text'] as String).trim();
      final newStateJson = result['state_json'] as String?;

      // If we have pronunciation feedback, append it in a readable way.
      final pronLine = result['pronunciation_score_line'];
      if (_mode == 'language_learning' &&
          pronLine is String &&
          pronLine.trim().isNotEmpty) {
        aiText = '$aiText\n\n$pronLine';
      }

      if (_mode == 'language_learning') {
        _languageStateJson = newStateJson;
      } else {
        _legacyStateJson = newStateJson;
      }

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
  // STT TEMP BUBBLE MANAGEMENT
  // ===========================================================================

  void _removeSttTempBubbleIfAny() {
    if (!mounted) return;
    setState(() {
      _messages.removeWhere(
        (m) => m.isUser == true && m.text.startsWith('[🎙️'),
      );
    });
  }

// ===========================================================================
// AUDIO → STT → (DRAFT) TEXT
// ===========================================================================
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

  final user = _client.auth.currentUser;
  if (user == null) {
    _showSnack('Not signed in; cannot send audio.');
    return;
  }

  try {
    final bytes = await file.readAsBytes();
    final base64Audio = base64Encode(bytes);

    if (mounted) {
      setState(() {
        _isTranscribing = true;
      });
    }

    // Determine current conversation mode once, so STT can behave differently.
    // We want LEGACY to be as reliable as possible: L1-only, no auto-detect.
    final String mode = _mode; // 'legacy' | 'language_learning' | 'avatar'
    final bool isLegacyMode = mode == 'legacy';

    // PRIMARY STT LANGUAGE:
    // - LEGACY: always listen in preferred/native language (L1) for reliability.
    // - Other modes: respect the current speaking mode (_sttLanguageCode).
    final String primaryCode =
        isLegacyMode ? _preferredLocale : _sttLanguageCode;

    // Alternative codes:
    // - For LEGACY, we pass NO alt codes (no auto-detect).
    // - For language-learning / avatar, we include the "other side" so STT can
    //   still auto-detect in those more advanced modes.
    final altCodes = <String>{};

    if (!isLegacyMode) {
      if (_targetLocale != null &&
          _targetLocale!.isNotEmpty &&
          _targetLocale != primaryCode) {
        altCodes.add(_targetLocale!);
      }

      if (_preferredLocale.isNotEmpty && _preferredLocale != primaryCode) {
        altCodes.add(_preferredLocale);
      }
    }

    final res = await _client.functions.invoke(
      'speech-to-text',
      body: {
        'user_id': user.id,
        'audio_base64': base64Audio,
        'mime_type': 'audio/aac',
        'language_code': primaryCode,
        'alt_language_codes': altCodes.toList(),
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

    final trimmedTranscript = transcript.trim();
    if (!mounted) return;

    final isLanguageLearningMode = mode == 'language_learning';
    final isAvatarMode = mode == 'avatar';

    debugPrint(
      'STT routing → mode=$mode '
      '(legacy=$isLegacyMode, lang=$isLanguageLearningMode, avatar=$isAvatarMode, '
      'primary=$primaryCode, alt=${altCodes.toList()})',
    );

    // FAST LOOP FOR ALL MODES:
    // - LEGACY: STT (L1-only) → auto-send → Gemini
    // - LANGUAGE-LEARNING + AVATAR: STT (L1/L2-aware) → auto-send → Gemini
    await _sendTextMessage(trimmedTranscript);

    // If you ever want a subtle toast here:
    // _showSnack('Sent via voice input.');
  } catch (e, st) {
    debugPrint('STT error: $e\n$st');
    _showSnack('Failed to transcribe audio: $e');
  } finally {
    if (mounted) {
      setState(() {
        _isTranscribing = false;
      });
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

      // Show the photo bubble in the chat.
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

      // Ask Gemini to describe the media (internal description only).
      final desc = await _describeMediaWithGemini(
        file: file,
        mimeType: 'image/jpeg',
        mediaType: 'photo',
      );

      final targetLocale =
          _hasTargetLanguage ? _targetLocale! : _preferredLocale;

      // Build the text prompt that will be sent through _sendTextMessage.
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

      // Send the prompt to the AI brain via the central pipeline.
      // We already showed a "Photo uploaded." user bubble, so no extra user bubble here.
      await _sendTextMessage(prompt, showUserBubble: false);
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

      // Show the video bubble in the chat.
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

      // Ask Gemini to describe the video (internal description only).
      final desc = await _describeMediaWithGemini(
        file: file,
        mimeType: 'video/mp4',
        mediaType: 'video',
      );

      final targetLocale =
          _hasTargetLanguage ? _targetLocale! : _preferredLocale;

      // Build the text prompt that will be sent through _sendTextMessage.
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

      // Send the prompt to the AI brain via the central pipeline.
      await _sendTextMessage(prompt, showUserBubble: false);
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
          // Conversation mode picker: legacy / language learning / avatar
          IconButton(
            icon: const Icon(Icons.tune),
            tooltip: 'Change conversation mode',
            onPressed: _showModePicker,
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

          // Mic enable/disable
          IconButton(
            icon: Icon(_micEnabled ? Icons.mic : Icons.mic_off),
            tooltip:
                _micEnabled ? 'Disable microphone' : 'Enable microphone',
            onPressed: _toggleMicEnabled,
          ),

          // Change AI voice (TTS voice picker)
          IconButton(
            icon: const Icon(Icons.record_voice_over),
            tooltip: 'Change AI voice',
            onPressed: _showVoicePicker,
          ),

          // Main overflow menu: story library, avatar, language-learning settings, app settings
          PopupMenuButton<_MainMenuAction>(
            icon: const Icon(Icons.more_horiz),
            tooltip: 'More options',
            onSelected: _handleMainMenuAction,
          itemBuilder: (context) {
            final items = <PopupMenuEntry<_MainMenuAction>>[
              const PopupMenuItem<_MainMenuAction>(
                value: _MainMenuAction.storyLibrary,
                child: Text('Story Library'),
              ),
              const PopupMenuItem<_MainMenuAction>(
                value: _MainMenuAction.coverage,
                child: Text('Coverage Map'),
              ),
              const PopupMenuItem<_MainMenuAction>(
                value: _MainMenuAction.endSession,
                child: Text('End Session & Rebuild Insights'),
              ),
              const PopupMenuItem<_MainMenuAction>(
                value: _MainMenuAction.settings,
                child: Text('Settings'),
              ),
            ];

            // Only show this option when language-learning mode is active.
            if (_isLanguageLearningMode) {
              items.insert(
                2,
              const PopupMenuItem<_MainMenuAction>(
                value: _MainMenuAction.languageLearningSettings,
                child: Text('Language learning settings'),
              ),
            );
          }

          return items;
        },
      ),

          // Language-learning tutor tools (still separate; only visible in LL mode)
          if (_isLanguageLearningMode)
            PopupMenuButton<_TutorQuickAction>(
              icon: const Icon(Icons.more_vert),
              tooltip: 'Tutor tools',
              onSelected: (value) {
                switch (value) {
                  case _TutorQuickAction.showProgress:
                    _sendMetaCommand('/progress');
                    break;

                  case _TutorQuickAction.advance:
                    _sendMetaCommand('/advance');
                    break;

                  case _TutorQuickAction.goBack:
                    _sendTextMessage('/back');
                    break;

                  case _TutorQuickAction.pronunciationDrill:
                    _sendMetaCommand(
                      'Please focus now on pronunciation drill for the main phrase of the current lesson. '
                      'Use short listen → repeat → say-it-yourself steps and follow the structured drill steps '
                      'from the lesson state, without switching to a different topic.',
                    );
                    break;

                  case _TutorQuickAction.reviewLesson:
                    _sendMetaCommand(
                      'Please give me a short review of the current lesson: recap the key phrases and meanings, '
                      'ask me a few comprehension and recall questions, and keep everything at the same difficulty level.',
                    );
                    break;

                  case _TutorQuickAction.redoLesson:
                    _sendMetaCommand(
                      'Please restart this lesson from the beginning so I can redo it. '
                      'Reset the lesson stages for this unit/lesson, but still respect my overall proficiency level.',
                    );
                    break;
                }
              },
              itemBuilder: (context) => const [
                PopupMenuItem<_TutorQuickAction>(
                  value: _TutorQuickAction.showProgress,
                  child: Text('Show lesson progress'),
                ),
                PopupMenuItem<_TutorQuickAction>(
                  value: _TutorQuickAction.advance,
                  child: Text('Skip ahead (too easy)'),
                ),
                PopupMenuItem<_TutorQuickAction>(
                  value: _TutorQuickAction.goBack,
                  child: Text('Go back (too hard)'),
                ),
                PopupMenuItem<_TutorQuickAction>(
                  value: _TutorQuickAction.pronunciationDrill,
                  child: Text('Pronunciation drill (current phrase)'),
                ),
                PopupMenuItem<_TutorQuickAction>(
                  value: _TutorQuickAction.reviewLesson,
                  child: Text('Review this lesson'),
                ),
                PopupMenuItem<_TutorQuickAction>(
                  value: _TutorQuickAction.redoLesson,
                  child: Text('Redo lesson from start'),
                ),
              ],
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
          if (_isTranscribing)
            const LinearProgressIndicator(
              minHeight: 2,
            ),
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

    String _stripLeadingTagsForDisplay(String text) {
      final tagRegex = RegExp(r'^\[([^\]]+)\]\s*');
      final lines = text.split('\n');
      final cleaned = lines.map((line) {
      final match = tagRegex.firstMatch(line);
      if (match != null) {
        return line.substring(match.end);
      }
      return line;
    }).toList();
    return cleaned.join('\n');
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
                          _stripLeadingTagsForDisplay(msg.text),
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
            child: const Text('Stop & Transcribe'),
          ),
        ],
      ),
    );
  }

  Widget _buildSpeakingModeChip(ThemeData theme) {
    final hasTarget = _hasTargetLanguage;
    final isNative = _isSpeakingNative;

    // What label to show on the chip.
    final label = hasTarget
        ? (isNative ? 'Speaking: Native' : 'Speaking: Target')
        : 'Speaking: Native';

    return InkWell(
      onTap: () {
        if (!hasTarget) {
          // No distinct target language configured; explain to the user.
          _showSnack(
            'Set a target language in preferences to enable native/target mic toggle.',
          );
          return;
        }

        setState(() {
          if (_speakingMode == 'native') {
            _speakingMode = 'target';
            if (_targetLocale != null && _targetLocale!.isNotEmpty) {
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
// COVERAGE MAP SCREEN
// ============================================================================

class CoverageScreen extends StatelessWidget {
  const CoverageScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final client = Supabase.instance.client;
    final user = client.auth.currentUser;

    if (user == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Coverage')),
        body: const Center(
          child: Text('Please sign in to view coverage.'),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Coverage')),
      body: _CoverageView(
        supabase: client,
        userId: user.id,
      ),
    );
  }
}

class _CoverageView extends StatefulWidget {
  final SupabaseClient supabase;
  final String userId;

  const _CoverageView({
    required this.supabase,
    required this.userId,
  });

  @override
  State<_CoverageView> createState() => _CoverageViewState();
}

class _CoverageViewState extends State<_CoverageView> {
  Map<String, dynamic>? _coverage;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCoverage();
  }

  Future<void> _loadCoverage() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final res = await widget.supabase
          .from('coverage_map_json')
          .select('data')
          .eq('user_id', widget.userId)
          .maybeSingle();

      if (res == null) {
        setState(() {
          _coverage = null;
          _loading = false;
        });
        return;
      }

      final data = res['data'];
      if (data is Map<String, dynamic>) {
        setState(() {
          _coverage = data;
          _loading = false;
        });
      } else {
        setState(() {
          _error = 'Unexpected coverage_map_json.data shape.';
          _loading = false;
        });
      }
    } catch (e) {
      setState(() {
        _error = 'Failed to load coverage: $e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Error loading coverage',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                _error!,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed: _loadCoverage,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_coverage == null) {
      return const Center(
        child: Text(
          'No coverage data yet.\nTry recording some legacy stories first.',
          textAlign: TextAlign.center,
        ),
      );
    }

    final global = _coverage!['global'] as Map<String, dynamic>? ?? {};
    final chapters = (_coverage!['chapters'] as Map?) ?? {};

    final totalMemories = (global['total_memories'] ?? 0) as int;
    final totalWords = (global['total_words_estimate'] ?? 0) as int;
    final earliestYear = global['earliest_year'];
    final latestYear = global['latest_year'];
    final themes = (global['dominant_themes'] as List?) ?? const [];

        // Define a sensible fixed order for chapters
    const orderedKeys = [
      'early_childhood',
      'adolescence',
      'early_adulthood',
      'midlife',
      'later_life',
      'family_relationships',
      'work_career',
      'education',
      'health_wellbeing',
      'hobbies_interests',
      'beliefs_values',
      'major_events',
    ];

    final chapterEntries = chapters.entries
        .where((e) => e.value is Map)
        .map<Map<String, dynamic>>((e) {
      final m = e.value as Map;
      return {
        'key': m['key'] ?? e.key,
        'label': m['label'] ?? e.key,
        'coverage_score': (m['coverage_score'] ?? 0.0) as num,
        'memory_count': (m['memory_count'] ?? 0) as int,
        'summary_snippet': m['summary_snippet'],
      };
    }).toList()
      ..sort((a, b) {
        final keyA = a['key'] as String;
        final keyB = b['key'] as String;

        final idxA = orderedKeys.indexOf(keyA);
        final idxB = orderedKeys.indexOf(keyB);

        // If both are in our known list, sort by that order
        if (idxA != -1 && idxB != -1) {
          return idxA.compareTo(idxB);
        }
        // If only one is known, known one comes first
        if (idxA != -1) return -1;
        if (idxB != -1) return 1;

        // Fallback: alphabetical by label
        return (a['label'] as String)
            .toLowerCase()
            .compareTo((b['label'] as String).toLowerCase());
      });

    final bottomInset = MediaQuery.of(context).padding.bottom;

    return RefreshIndicator(
      onRefresh: _loadCoverage,
      child: ListView(
        padding: EdgeInsets.fromLTRB(
          16,
          16,
          16,
          16 + bottomInset + 24, // extra cushion above Android nav bar
        ),
        children: [
          _buildGlobalCard(
            context,
            totalMemories: totalMemories,
            totalWords: totalWords,
            earliestYear: earliestYear,
            latestYear: latestYear,
            themes: themes.cast<String>(),
          ),
          const SizedBox(height: 16),
          Text(
            'Chapters',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          if (chapterEntries.isEmpty)
            const Text('No chapters have coverage yet.')
          else
            ...chapterEntries.map((c) => _buildChapterCard(context, c)),
        ],
      ),
    );
  }

  Widget _buildGlobalCard(
    BuildContext context, {
    required int totalMemories,
    required int totalWords,
    dynamic earliestYear,
    dynamic latestYear,
    required List<String> themes,
  }) {
    final theme = Theme.of(context);

    String timeSpan;
    if (earliestYear == null && latestYear == null) {
      timeSpan = 'Not enough data yet';
    } else if (earliestYear == latestYear) {
      timeSpan = 'Around $earliestYear';
    } else {
      timeSpan = '$earliestYear – $latestYear';
    }

    return Card(
      elevation: 1,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Your Life Story Coverage',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text('Memories captured: $totalMemories'),
            Text('Estimated words recorded: $totalWords'),
            Text('Time span covered: $timeSpan'),
            const SizedBox(height: 8),
            if (themes.isNotEmpty) ...[
              Text(
                'Dominant themes:',
                style: theme.textTheme.bodyMedium!
                    .copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: themes
                    .map(
                      (t) => Chip(
                        label: Text(t),
                        visualDensity: VisualDensity.compact,
                      ),
                    )
                    .toList(),
              ),
            ] else
              const Text('Themes: Not enough data yet'),
          ],
        ),
      ),
    );
  }

  Widget _buildChapterCard(
    BuildContext context,
    Map<String, dynamic> chapter,
  ) {
    final label = chapter['label'] as String? ?? chapter['key'] as String;
    final score =
        (chapter['coverage_score'] as num).toDouble().clamp(0.0, 1.0);
    final memoryCount = chapter['memory_count'] as int? ?? 0;
    final snippet = chapter['summary_snippet'] as String?;

    final percent = (score * 100).round();

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      elevation: 0.5,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Expanded(
                  child: LinearProgressIndicator(
                    value: score,
                    minHeight: 6,
                  ),
                ),
                const SizedBox(width: 8),
                Text('$percent%'),
              ],
            ),
            const SizedBox(height: 4),
            Text('Memories in this chapter: $memoryCount'),
            if (snippet != null && snippet.trim().isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                snippet,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: Colors.grey),
              ),
            ],
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
                _controller.value.isPlaying
                    ? Icons.pause
                    : Icons.play_arrow,
              ),
            )
          : null,
    );
  }
}
