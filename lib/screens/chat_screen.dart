library chat_screen;

// Legacy v1: ship as Legacy-only (hide language learning + avatar UI without deleting code)

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

import 'package:flutter/foundation.dart';
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
import '../prompts/media_followup_prompts.dart';
import 'settings_screen.dart';
import 'story_library_screen.dart';

part 'chat_screen_models.dart';
part 'chat_screen_coverage.dart';
part 'chat_screen_video.dart';
part 'chat_screen_audio.dart';
part 'chat_screen_tts.dart';


// Legacy v1: ship as Legacy-only (hide language learning + avatar UI without deleting code)
const bool kLegacyOnly = false;

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
  sessionHistory,
  sessionReview, // re-open latest Session Review (if available)
  avatarMode,
  languageLearningSettings,
  coverage,        // coverage map screen
  settings,
  endSession,      // NEW: trigger end-session + heavy processing
}


// ---------------------------------------------------------------------------
// Summary helpers (UI reads from session_insights only; plain columns are mirrors)
// ---------------------------------------------------------------------------
// End-session UI sanitation:
// If the server returns a "Not enough data yet" longitudinal stub, we suppress
// any legacy keyword-noise sections (recurring themes/focus/drivers) so the UI
// doesn't show contradictory content.
// ---------------------------------------------------------------------------
Map<String, dynamic> _sanitizeSessionInsightsForEndSessionUI(Map<String, dynamic> si) {
  bool containsNotEnoughData(dynamic v) {
    if (v is String) {
      final t = v.toLowerCase();
      return t.contains('not enough data yet') || t.contains('not enough meaningful sessions');
    }
    if (v is Map) {
      for (final entry in v.entries) {
        if (containsNotEnoughData(entry.value)) return true;
      }
    }
    if (v is List) {
      for (final item in v) {
        if (containsNotEnoughData(item)) return true;
      }
    }
    return false;
  }

  final out = Map<String, dynamic>.from(si);

  if (!containsNotEnoughData(out)) {
    return out;
  }

  // Best-effort: different pipelines have used different key names over time.
  const keysToDrop = <String>{
    'recurring_themes',
    'recurringThemes',
    'ongoing_focus_areas',
    'ongoingFocusAreas',
    'underlying_drivers',
    'underlyingDrivers',
    'themes',
    'focus_areas',
    'focusAreas',
    'drivers',
    'keyword_themes',
    'keywordThemes',
  };

  void scrub(dynamic node) {
    if (node is Map) {
      for (final k in List<String>.from(node.keys.map((e) => e.toString()))) {
        final key = k.toString();
        if (keysToDrop.contains(key)) {
          node[key] = (node[key] is List) ? <dynamic>[] : null;
          continue;
        }
        scrub(node[key]);
      }
    } else if (node is List) {
      for (final item in node) {
        scrub(item);
      }
    }
  }

  scrub(out);

  return out;
}

// ---------------------------------------------------------------------------
Map<String, dynamic>? _parseJsonMap(dynamic raw) {
  if (raw == null) return null;
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return Map<String, dynamic>.from(raw);
  if (raw is String) {
    final s = raw.trim();
    if (s.isEmpty) return null;
    try {
      final decoded = jsonDecode(s);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {}
  }
  return null;
}

bool _looksLikeTranscript(String s) {
  final t = s.trim();
  if (t.isEmpty) return false;
  if (t.length < 120) return false;
  final lower = t.toLowerCase();
  // Heuristic: looks like role-prefixed chat logs.
  if (lower.contains('assistant:') || lower.contains('user:')) return true;
  // Many line breaks + short lines.
  final lines = t.split('\n').where((l) => l.trim().isNotEmpty).toList();
  if (lines.length >= 6) {
    final avg = lines.map((l) => l.trim().length).fold<int>(0, (a, b) => a + b) / lines.length;
    if (avg < 55) return true;
  }
  return false;
}

bool _looksProceduralPlaceholder(String s) {
  final t = s.trim().toLowerCase();
  if (t.isEmpty) return false;

  // Common "no real content captured" placeholders we never want to surface as the primary Session History summary.
  if (t.contains('checked in briefly')) return true;
  if (t.contains('did not record a detailed story')) return true;
  if (t.contains('no detailed story')) return true;
  if (t.contains('presence-check')) return true;
  if (t.contains('you were prompted') && t.length < 240) return true;

  return false;
}


String _pickSummaryFromSessionInsights(Map<String, dynamic>? si, {required bool full}) {
  if (si == null) return '';
  String pick(dynamic v) => (v is String) ? v.trim() : '';
  final reframed = _parseJsonMap(si['reframed']);
  final rShort = pick(reframed?['short_summary']);
  final rFull = pick(reframed?['full_summary']);
  final siShort = pick(si['short_summary']);
  final siFull = pick(si['full_summary']);

  if (full) {
    if (siFull.isNotEmpty && !_looksLikeTranscript(siFull) && !_looksProceduralPlaceholder(siFull)) return siFull;
    if (rFull.isNotEmpty && !_looksLikeTranscript(rFull) && !_looksProceduralPlaceholder(rFull)) return rFull;
    if (rFull.isNotEmpty) return rFull;
    if (siFull.isNotEmpty) return siFull;
    return '';
  } else {
    if (siShort.isNotEmpty && !_looksLikeTranscript(siShort) && !_looksProceduralPlaceholder(siShort)) return siShort;
    if (rShort.isNotEmpty && !_looksLikeTranscript(rShort) && !_looksProceduralPlaceholder(rShort)) return rShort;
    if (siFull.isNotEmpty && !_looksLikeTranscript(siFull) && !_looksProceduralPlaceholder(siFull)) return siFull;
    if (rFull.isNotEmpty && !_looksLikeTranscript(rFull) && !_looksProceduralPlaceholder(rFull)) return rFull;
    if (rShort.isNotEmpty) return rShort;
    if (siShort.isNotEmpty) return siShort;
    return '';
  }
}

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

// In-memory message model for the chat UI

class _ChatScreenState extends State<ChatScreen> {
  // Cached navigation args so the user can re-open the latest Session Review at any time.
  Map<String, dynamic>? _lastSessionReviewNavArgs;

  // UI controllers
  final TextEditingController _textController = TextEditingController();
  final ScrollController _scrollController = ScrollController();

  // Supabase + AI brain
  final SupabaseClient _client = Supabase.instance.client;
  final AIBrainService _aiBrain = AIBrainService.instance;

  Future<void> _runDiagnostics() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Not signed in')),
      );
      return;
    }

    try {
      final res = await _client.functions.invoke(
        'ai-brain',
        body: {
          'user_id': user.id,
          'conversation_id': _conversationId,
          'message_text': '__DIAGNOSTIC__',
          'diagnostic': true,
        },
      );

      final pretty = const JsonEncoder.withIndent('  ').convert(res.data);

      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Diagnostics'),
          content: SingleChildScrollView(child: SelectableText(pretty)),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Diagnostics failed: $e')),
      );
    }
  }


  // In-memory message list
  final List<_ChatMessage> _messages = [];


  // De-dupe assistant replies (guards against retries returning the same reply)
  final Set<String> _seenReplyIds = <String>{};

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
  String _ttsLanguageCode = WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();
  String _sttLanguageCode = WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();

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
    final rawSegment = match.group(0) ?? '';
    var segment = rawSegment.trim();
    if (segment.isEmpty) continue;

    // Detect explicit tags (we'll strip them before speaking).
    final hasL1Tag = RegExp(r'(\[\s*L1\s*\])|\bL1\b', caseSensitive: false)
        .hasMatch(segment);
    final hasL2Tag = RegExp(r'(\[\s*L2\s*\])|\bL2\b', caseSensitive: false)
        .hasMatch(segment);

    // In language_learning mode, prefer speaking only the learner's target (L2).
    // - If a segment is explicitly tagged L1 (and not L2), skip it.
    // - If the target language is Thai, also skip any segment that lacks Thai script
    //   (romanizations tend to get spelled letter-by-letter by many engines).
    if ((_mode ?? '').toLowerCase() == 'language_learning') {
    // In language_learning mode we speak both L1 and L2; cleanup below removes tags/romanization.

      final target = (_targetLocale ?? '').toLowerCase();
      if (target.startsWith('th')) {
        final hasThai = _thaiCharRegex.hasMatch(segment);
        if (!hasThai) continue;
      }
    }

    // Strip L1/L2 tags and other meta markers BEFORE cleaning/detection.
    segment = segment
        .replaceAll(
          RegExp(r'\[\s*L[12]\s*\]\s*', caseSensitive: false),
          '',
        )
        .replaceAll(
          RegExp(r'\bL[12]\b\s*[:\-–—]?\s*', caseSensitive: false),
          '',
        )
        .trim();

    // General cleanup (URLs, markdown, punctuation that gets read aloud, etc.)
    segment = _cleanForTts(segment);
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
    String _preferredLocale = WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();

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
    String _voiceMode = 'chatbot';
    bool get _isChatbotMode => _voiceMode == 'chatbot';

    // Conversation mode: 'legacy' | 'language_learning'
    String _mode = 'legacy';

  // Language-learning artifacts for the current turn/session
  List<_LearningBlock> _learningBlocksCurrent = <_LearningBlock>[];

    bool get _isLegacyMode => kLegacyOnly ? true : (_mode == 'legacy');
    bool get _isLanguageLearningMode => kLegacyOnly ? false : (_mode == 'language_learning');
    bool get _isAvatarMode => kLegacyOnly ? false : (_mode == 'avatar');
   
    @override
    void initState() {
      super.initState();

      if (kLegacyOnly) {
        _mode = 'legacy';
        _targetLocale = null;
      }
      _initRecorder();
      _loadMicPrefs();
      _initTts();
      _ensureProfileLocaleDefaults(); 
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

    // -----------------------------------------------------------------------------
  // Force an explicit end-session call to ai-brain (bypasses service layer)
  // -----------------------------------------------------------------------------
  Future<void> _invokeAiBrainEndSessionDirect() async {
  final client = Supabase.instance.client;
  final user = client.auth.currentUser;
  if (user == null) return;

  final String userId = user.id;

  // IMPORTANT: use your existing conversation id variable here.
  // If your file uses something else (e.g. _sessionKey), swap it in.
  final String conversationId = _conversationId ?? 'default';

  // IMPORTANT: use your existing mode variable here.
  final String mode = _mode; // "legacy" / "language_learning" / "avatar"

  final payload = <String, dynamic>{
    'user_id': userId,
    'conversation_id': conversationId,
    'mode': mode,

    // ✅ This is the critical bit
    'end_session': true,

    // Optional: keep server happy even if it expects message_text
    'message_text': '__END_SESSION__',
  };

  try {
    await client.functions.invoke('ai-brain', body: payload);
  } catch (e) {
    // Don’t crash UI
    debugPrint('❌ End-session invoke failed: $e');
  }
  }

    void _showSnack(String msg) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(msg)),
      );
    }

  Future<void> _speakL2Text(String text, String locale) async {
    final t = text.trim();
    if (t.isEmpty) return;

    try {
      // Manual playback should work even if auto-voice is "silent".
      // Also stop any in-flight utterance to avoid no-op on some engines.
      await _tts.stop();
      await _tts.awaitSpeakCompletion(true);

      var out = t;
      if (locale.toLowerCase().startsWith('th')) {
        out = _cleanupThaiForTts(out);
      }
      out = out.trim();
      if (out.isEmpty) return;

      await _tts.setLanguage(locale);
      await _tts.speak(out);
      await _waitForTtsDone();
    } catch (e) {
      debugPrint('⚠️ _speakL2Text failed: $e');
    }
  }


  void _showModePicker() async {
    final currentMode = _mode; // "legacy", "language_learning", "avatar"

    final result = await showModalBottomSheet<_ConversationModeChoice>(
      context: context,
      showDragHandle: true,
      builder: (context) {
        _ConversationModeChoice? selected;
        if (currentMode == 'avatar') {
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
            subtitle: Text(subtitle, maxLines: 3, overflow: TextOverflow.ellipsis),
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
              ),              buildTile(
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
          // Language-learning mode is no longer exposed in the UI.
          _mode = 'legacy';
          break;
        case _ConversationModeChoice.avatar:
          if (kLegacyOnly) { _mode = 'legacy'; break; }
          _mode = 'avatar';
          break;
      }
    });

    _showSnack(
      _mode == 'avatar'
            ? 'Avatar mode (answering as you)'
            : 'Legacy storytelling mode',
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

    String _normalizeLocale(String? raw, {String fallback = ''}) {
      final s = (raw ?? '').trim();
      if (s.isEmpty) return fallback.isNotEmpty ? fallback : WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();

      // normalize separators
      final norm = s.replaceAll('_', '-');

      // If it’s a short language tag, map to a stable BCP-47 default.
      final lower = norm.toLowerCase();
      // (no hardcoded language mappings)
      // (no hardcoded language mappings)
      // (no hardcoded language mappings)

      return norm;
    }

    String _deviceLocaleBcp47() {
      final loc = WidgetsBinding.instance.platformDispatcher.locale;
      final lang = loc.languageCode.trim();
      final country = (loc.countryCode ?? '').trim();
      final raw = country.isEmpty ? lang : '$lang-$country';
      return _normalizeLocale(raw);
    }

    Future<void> _ensureProfileLocaleDefaults() async {
  final user = _client.auth.currentUser;
  if (user == null) return;

  final deviceTag =
      WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();
  final normalizedDevice = _normalizeLocale(deviceTag);

  try {
    final row = await _client
        .from('profiles')
        .select('preferred_language, device_locale')
        .eq('id', user.id)
        .maybeSingle();

    final existingPref = (row is Map<String, dynamic>)
        ? (row['preferred_language'] as String?)?.trim()
        : null;

    final patch = <String, dynamic>{
      'id': user.id,
      'device_locale': normalizedDevice,
    };

    if (existingPref == null || existingPref.isEmpty) {
      patch['preferred_language'] = normalizedDevice;
    }

    await _client.from('profiles').upsert(patch);
  } catch (e) {
    // ignore: avoid_print
    print('Failed to ensure profile locale defaults: $e');
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
    //    If DB preferred_language is missing, fall back to device locale.
    // ------------------------------------------------------------------
    final deviceTag =
      WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag();

    final normalizedDevice = _normalizeLocale(deviceTag, fallback: '');

    // DB pref if present, else device locale.
    final resolvedPref = (prefRaw != null && prefRaw.trim().isNotEmpty)
      ? _normalizeLocale(prefRaw, fallback: normalizedDevice)
      : normalizedDevice;

    final resolvedTarget = (targetRaw == null || targetRaw.trim().isEmpty)
      ? null
      : _normalizeLocale(targetRaw, fallback: '');

    // Best-effort: persist device locale + preferred_locale if missing in DB.
    // This prevents "en" (non-BCP47) from breaking STT later.
    try {
      final user = _client.auth.currentUser;
      if (user != null) {
        await _client.from('profiles').upsert({
        'id': user.id,
        'device_locale': _deviceLocaleBcp47(),
        'preferred_locale': resolvedPref,
        // keep preferred_language as-is if you want; or optionally also store short code:
        // 'preferred_language': resolvedPref.split('-').first,
        });
      }
    } catch (e) {
    // ignore: avoid_print
    print('Failed to persist device_locale/preferred_locale: $e');
    }

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
      // In language-learning mode, default the mic to the target language (L2) if available.
      // This ensures Thai speech produces Thai script instead of English transliteration.
      if (_isLanguageLearningMode && _hasTargetLanguage && (_targetLocale ?? '').trim().isNotEmpty) {
        _speakingMode = 'target';
        _sttLanguageCode = _targetLocale!;
      }

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
    // Let _sendTextMessage own the _isSending lifecycle.
    if (_isSending) return;

    await _sendTextMessage(
      "__END_SESSION__",
      endSession: true,
      showUserBubble: false,
    );

    _showSnack("End session triggered.");
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

      // If we're currently in Legacy mode, keep speech input in L1 even if a
      // target language is configured.
      if (_mode == 'legacy') {
        _speakingMode = 'native';
      }

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

    // 2) Persist to SharedPreferences + Supabase profile (best-effort)
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('target_locale', result.targetLocale);
      await prefs.setString('learning_level', result.learningLevel);
    } catch (e) {
      // ignore: avoid_print
      print('Failed to save language-learning prefs to SharedPreferences: $e');
    }

    try {
      final user = _client.auth.currentUser;
      if (user != null) {
        final normalizedTarget = _normalizeLocale(result.targetLocale);

        await _client.from('profiles').upsert({
          'id': user.id,
          // keep your existing preferred_language as the source of truth for L1
          'target_language': normalizedTarget,
          'learning_level': result.learningLevel,
          // keep supported_languages aligned since your loader uses it as default L2
          'supported_languages': [normalizedTarget.split('-').first],
        });
      }
    } catch (e) {
      // ignore: avoid_print
      print('Failed to save target_language/learning_level to Supabase: $e');
    }

    _showSnack('Language learning settings updated.');

    // 3) ALSO persist to Supabase profiles (so target_language / learning_level are not NULL)
    try {
      final user = _client.auth.currentUser;
      if (user != null) {
        await _client.from('profiles').upsert({
        'id': user.id,
        'target_language': result.targetLocale,     // keep your existing column name
        'learning_level': result.learningLevel,     // keep your existing column name
        'preferred_locale': _preferredLocale,       // STT-safe
        'device_locale': _deviceLocaleBcp47(),
        });
      }
    } catch (e) {
    // ignore: avoid_print
    print('Failed to persist language settings to profiles: $e');
    }
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
    // Purpose: remove things that TTS engines tend to *read aloud* (URLs, markdown,
    // code-ish punctuation), while preserving Thai script when present.
    var cleaned = text;

    // 0) Strip explicit language labels like "L1:" / "L2:" or "[L1]" / "[L2]".
    cleaned = cleaned.replaceAll(RegExp(r'^\s*(?:\[\s*(?:L1|L2)\s*\]|(?:L1|L2))\s*[:\-–—]?\s*', caseSensitive: false, multiLine: true), '');
    cleaned = cleaned.replaceAll(RegExp(r'\[\s*(?:L1|L2)\s*\]', caseSensitive: false), '');


    // 1) Strip URLs (prevents "colon slash slash" and "slash" being spoken).
    cleaned = cleaned.replaceAll(RegExp(r'https?:\/\/\S+'), '');

    // 2) Convert markdown links: [label](url) -> label
    cleaned = cleaned.replaceAllMapped(
      RegExp(r'\[([^\]]+)\]\([^\)]+\)'),
      (m) => m.group(1) ?? '',
    );

    // 3) Remove common markdown formatting tokens.
    cleaned = cleaned.replaceAll(RegExp(r'[*_~`]+'), '');

    // 4) Replace slashes that join tokens (e.g., "L1/L2") with a space.
    cleaned = cleaned.replaceAllMapped(
      RegExp(r'([A-Za-z0-9])\/([A-Za-z0-9])'),
      (m) => '${m.group(1)} ${m.group(2)}',
    );

    // 5) Replace remaining slashes / backslashes with a space.
    cleaned = cleaned.replaceAll(RegExp(r'[\\/]+'), ' ');

    // 6) Replace punctuation that some engines speak as words.
    cleaned = cleaned
        .replaceAll(RegExp(r'[!¡]'), '.')   // "exclamation mark"
        .replaceAll('?', '.')               // "question mark"
        .replaceAll(RegExp(r'[#@<>\[\]{}|^]+'), ' ')
        .replaceAll(RegExp(r'[_=*]+'), ' ');

    // 6b) Drop parenthetical/bracketed romanization/IPA chunks (Latin/IPA only).
    // Example: "สวัสดี (sawatdee)" -> "สวัสดี"
    //          "[tɕʰaːj]" -> ""
    final romanParen = RegExp(r"\((?:[A-Za-z\s\-\u02BC\u02B9']+)\)");
    cleaned = cleaned.replaceAll(romanParen, ' ');

    final romanBrackets = RegExp(r"\[(?:[A-Za-z\s\-\u02BC\u02B9'ːˑˈˌ\u0250-\u02AF]+)\]");
    cleaned = cleaned.replaceAll(romanBrackets, ' ');

    // 7) Collapse whitespace.
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

    // 0) Strip explicit language labels like "L1:" / "L2:" or "[L1]" / "[L2]".
    cleaned = cleaned.replaceAll(RegExp(r'^\s*(?:\[\s*(?:L1|L2)\s*\]|(?:L1|L2))\s*[:\-–—]?\s*', caseSensitive: false, multiLine: true), '');
    cleaned = cleaned.replaceAll(RegExp(r'\[\s*(?:L1|L2)\s*\]', caseSensitive: false), '');


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
  // ---------------------------------------------------------------------------
  // TTS HELPERS: ignore punctuation-only segments, strip leading punctuation, and
  // split mixed-script text into ordered segments without re-ordering.
  // ---------------------------------------------------------------------------
  bool _isTtsIgnorable(String text) {
    final t = text.trim();
    if (t.isEmpty) return true;
    // Punctuation-only tokens (common cause of TTS saying "dot").
    if (RegExp(r'^[\.,;:!\?\-–—]+$').hasMatch(t)) return true;
    return false;
  }

  String _stripLeadingPunctuation(String text) {
    // Remove stray leading punctuation like '.' that can get spoken as "dot".
    return text.replaceFirst(RegExp(r'^[\s\.,;:!\?\-–—]+'), '').trim();
  }

  List<Map<String, String>> _splitIntoOrderedTtsSegments(String text) {
    final out = <Map<String, String>>[];
    final matches = _languageSegmentRegex.allMatches(text);
    for (final m in matches) {
      var seg = (m.group(0) ?? '').trim();
      if (seg.isEmpty) continue;
      seg = _stripLeadingPunctuation(_cleanForTts(seg));
      if (_isTtsIgnorable(seg)) continue;
      final lang = _detectLangForSegment(seg);
      // If this is Thai, apply Thai cleanup for TTS.
      if (lang.toLowerCase().startsWith('th')) {
        seg = _cleanupThaiForTts(seg);
        if (seg.isEmpty) continue;
      }
      out.add({'lang': lang, 'text': seg});
    }
    return out;
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
    // NOTE: Manual playback (speaker button) should work even if auto-voice mode is 'silent'.
    // Auto-play behavior elsewhere still respects _voiceMode.

    final raw = msg.text.trim();
    if (raw.isEmpty) return;

    // IMPORTANT: Do NOT run _cleanForTts() before segmentation, because it strips [L1]/[L2] tags.
    final rawForSegmentation = raw;

    // We want to parse sequences like:
    // [L1] English text...
    // [L2] Thai text...
    // [en-US] more English...
    //
    // So we scan the whole string for [TAG] and grab the text that follows each
    // tag up to the next tag.
    final List<Map<String, String>> segments = [];
    final segmentRegex = RegExp(r'\[([^\]]+)\]\s*([^[]*)');
    final matches = segmentRegex.allMatches(rawForSegmentation).toList();

    // If there are NO [L1]/[L2]/[xx-YY] tags at all, fall back to the simpler
    // auto language splitter so the message is never completely silent.
    if (matches.isEmpty) {
      final sanitizedRaw = _cleanForTts(raw);
      if (sanitizedRaw.isEmpty) return;
      debugPrint('🔊 No explicit tags found in reply; falling back to auto L1/L2 segmentation.');
      await _speakTextWithAutoLanguage(sanitizedRaw);
      return;
    }

    // Speak any leading untagged text (usually L1 explanation) as L1.
    final firstStart = matches.first.start;
    if (firstStart > 0) {
      final leading = rawForSegmentation.substring(0, firstStart).trim();
      final leadingFixed = _stripLeadingPunctuation(_cleanForTts(leading));
      if (!_isTtsIgnorable(leadingFixed)) {
        segments.add({'lang': _preferredLocale, 'text': leadingFixed});
      }
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
      // Preserve the original in-line order (don’t bucket all L1 then all L2).
      segments.addAll(_splitIntoOrderedTtsSegments(textPart));
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
      // Preserve original order for mixed-script native segments.
      segments.addAll(_splitIntoOrderedTtsSegments(textPart));
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
    text = _stripLeadingPunctuation(text.trim());
    if (_isTtsIgnorable(text)) continue;
    
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
    // await _tts.stop(); // Avoid stopping between segments; it can cause choppy playback.
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

  // Cleans AI reply text for display (and downstream TTS segmentation) by removing
  // romanization-only clutter while keeping [L1]/[L2] content intact.
  //
  // Important: This is intentionally conservative—only removes:
  //  - Lines starting with [ROM] (or ROM:) and similar romanization-only blocks
  //  - A leading bracket-tag that looks like IPA/romanization (not a locale or L1/L2)
  //  - Lines that contain IPA/combining marks and no Thai characters
  String _cleanAiTextForChatBubble(String input) {
    if (input.isEmpty) return input;

    final thaiRegex = RegExp(r'[\u0E00-\u0E7F]');
    final localeTagRegex = RegExp(r'^[a-z]{2}(-[A-Z]{2})?$'); // e.g. en, en-US
    final allowedTags = <String>{'L1', 'L2', 'ROM'};

    final lines = input.split('\n');
    final out = <String>[];

    for (var rawLine in lines) {
      var line = rawLine;

      // Trim only for checks; keep original spacing where possible.
      final trimmed = line.trimLeft();

      // Drop standalone romanization segments if the model emits them as their own lines.
      if (trimmed.startsWith('[ROM]') || trimmed.startsWith('ROM:')) {
        continue;
      }

      // If a line begins with a bracket tag, consider stripping that tag if it's "noise".
      // Example noise: "[dtɔ̂ŋ náːm yùː tîː nǎi] ..."  (IPA / romanization)
      final tagMatch = RegExp(r'^\s*\[([^\]]+)\]\s*').firstMatch(line);
      if (tagMatch != null) {
        final tag = (tagMatch.group(1) ?? '').trim();

        final isAllowed = allowedTags.contains(tag.toUpperCase());
        final looksLikeLocale = localeTagRegex.hasMatch(tag);

        // Heuristic: treat as noise if it contains spaces or non-ASCII letters,
        // and it's not one of our known tags or a locale code.
        final hasSpaces = tag.contains(' ');
        final hasNonAscii = tag.runes.any((r) => r > 127);
        if (!isAllowed && !looksLikeLocale && (hasSpaces || hasNonAscii)) {
          // Remove just the bracket tag, keep the remaining content.
          line = line.replaceFirst(RegExp(r'^\s*\[[^\]]+\]\s*'), '');
        }
      }

      // Drop lines that are romanization-only (IPA / combining marks) and contain no Thai.
      // We keep normal English (ASCII) lines.
      final hasThai = thaiRegex.hasMatch(line);
      final hasCombining = RegExp(r'[\u0300-\u036F]').hasMatch(line); // combining diacritics
      final hasIpa = RegExp(r'[\u0250-\u02AF]').hasMatch(line); // IPA extensions
      if (!hasThai && (hasCombining || hasIpa)) {
        // If it still looks like a romanized chunk (not a normal sentence), drop it.
        // (Conservative: require at least 6 letters/spaces)
        final plain = line.replaceAll(RegExp(r'[^A-Za-z\s]'), '');
        if (plain.trim().length >= 6) continue;
      }

      out.add(line);
    }

    // Normalize excessive blank lines introduced by removals.
    var joined = out.join('\n');
    joined = joined.replaceAll(RegExp(r'\n{3,}'), '\n\n').trim();
    return joined;
  }

  void _addAiMessageAndMaybeSpeak(String text) {
    final cleanedText = _cleanAiTextForChatBubble(text);

    final msg = _ChatMessage(
      id: UniqueKey().toString(),
      text: cleanedText,
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

    if (saved == 'legacy' || saved == 'avatar') {
      if (!mounted) return;

      final mode = saved;
      setState(() => _mode = mode);

      await _applyEffectiveTtsConfig();
    }
  }

  Future<void> _setConversationMode(String mode) async {
    if (mode != 'legacy' && mode != 'avatar') return;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('conversation_mode', mode);

    if (!mounted) return;
    setState(() {
      _mode = mode;

      // In Legacy mode, the microphone should default to L1.
      // This prevents L2 bias lingering from Language mode.
      if (_mode == 'legacy') {
        _speakingMode = 'native';
        _sttLanguageCode = _preferredLocale;
      }
    });
    await _applyEffectiveTtsConfig();
  }

  Future<void> _toggleConversationMode() async {
    final next =
        _mode == 'avatar' ? 'legacy' : 'avatar';
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

  void _openLearningHub() {
  final user = _client.auth.currentUser;
  if (user == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Not signed in.')),
    );
    return;
  }

  Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) => _LearningHubScreen(
        client: _client,
        userId: user.id,
        currentBlocks: _learningBlocksCurrent,
        preferredLocale: _preferredLocale,
        targetLocale: _targetLocale,
        onSpeakL2: (text, locale) => _speakL2Text(text, locale),
      ),
    ),
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
      case _MainMenuAction.sessionHistory:
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => const SessionHistoryScreen(),
          ),
        );
        break;

      case _MainMenuAction.avatarMode:
        if (kLegacyOnly) { _showSnack('Avatar is not available in Legacy v1'); break; }
        _activateAvatarMode();
        break;

      case _MainMenuAction.languageLearningSettings:
        if (kLegacyOnly) { _showSnack('Language learning is disabled in Legacy v1'); break; }
        _showLanguageLearningSettingsSheet();
        break;

      case _MainMenuAction.coverage:
        _openCoverageScreen();
        break;

      case _MainMenuAction.sessionReview:
        _openLastSessionReview();
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

  
  Future<bool> _ensureLastSessionReviewNavArgs() async {
    if (_lastSessionReviewNavArgs != null) return true;

    final user = _client.auth.currentUser;
    if (user == null) return false;

    try {
      // Prefer the latest session for this user. Do NOT require conversation_id,
      // because mobile/client conversation ids can diverge from server-side ones.
      final res = await _client
          .from('memory_summary')
          .select('id, created_at, short_summary, session_insights')
          .eq('user_id', user.id)
          .order('created_at', ascending: false)
          .limit(1);

      if (res == null || res is! List || res.isEmpty) return false;
      if (res.first is! Map) return false;

      final row = Map<String, dynamic>.from(res.first as Map);

      final memorySummaryId = (row['id'] ?? '').toString().trim();
      final createdAt = (row['created_at'] ?? '').toString().trim();

      // Canonical summaries come from session_insights; plain columns are mirrors.
      final si = _parseJsonMap(row['session_insights']);
      final shortSummary =
          ((si?['short_summary'] ?? row['short_summary'] ?? '') as dynamic).toString().trim();
      final fullSummary = ((si?['full_summary'] ?? '') as dynamic).toString().trim();

      final dateLabel = createdAt.isNotEmpty ? createdAt : 'Session Review';

      _lastSessionReviewNavArgs = {
        'memorySummaryId': memorySummaryId.isNotEmpty ? memorySummaryId : 'n/a',
        'sessionKey': '',
        'dateLabel': dateLabel,
        'fallbackTitle': 'Session Review',
        'fallbackBody': (fullSummary.isNotEmpty
                ? fullSummary
                : (shortSummary.isNotEmpty ? shortSummary : ''))
            .trim(),
        'shortSummary': shortSummary,
        'fullSummary': fullSummary,
        'sessionInsights': (si ?? const <String, dynamic>{}),
      };

      return true;
    } catch (_) {
      return false;
    }
  }


  void _openLastSessionReview() async {
    final args = _lastSessionReviewNavArgs;
    if (args == null) {
      final ok = await _ensureLastSessionReviewNavArgs();
      if (!ok) {
        _showSnack('No Session Review available yet.');
        return;
      }
    }

    final nav = _lastSessionReviewNavArgs;
    if (nav == null) {
      _showSnack('No Session Review available yet.');
      return;
    }

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => EndSessionReviewScreen(
          memorySummaryId: (nav['memorySummaryId'] ?? '').toString(),
          sessionKey: (nav['sessionKey'] ?? '').toString(),
          dateLabel: (nav['dateLabel'] ?? 'Session Review').toString(),
          fallbackTitle: (nav['fallbackTitle'] ?? 'Session Review').toString(),
          fallbackBody: (nav['fallbackBody'] ?? '').toString(),
          shortSummary: (nav['shortSummary'] ?? '').toString(),
          fullSummary: (nav['fullSummary'] ?? '').toString(),
          sessionInsights: (nav['sessionInsights'] is Map)
              ? (nav['sessionInsights'] as Map).cast<String, dynamic>()
              : (nav['sessionInsights'] ?? const {}),
        ),
      ),
    );
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

  Future<void> _pinStorySeed() async {
  final supabase = Supabase.instance.client;
  final user = supabase.auth.currentUser;

  if (user == null) {
    _showSnack('You must be logged in to pin a story.');
    return;
  }

  // Prefer current text input; fallback to last user message
  String seedText = _textController.text.trim();

  if (seedText.isEmpty) {
    _ChatMessage? lastUserMsg;
    for (int i = _messages.length - 1; i >= 0; i--) {
      final m = _messages[i];
      if (m.isUser && m.text.isNotEmpty) {
        lastUserMsg = m;
        break;
      }
    }

if (lastUserMsg == null) {
  _showSnack('Nothing to pin yet.');
  return;
}

seedText = lastUserMsg.text.trim();

  }

  if (seedText.isEmpty) {
    _showSnack('Nothing to pin.');
    return;
  }

  final title = seedText.length > 60
      ? '${seedText.substring(0, 57)}…'
      : seedText;

  try {
    await supabase.from('story_seeds').insert({
      'user_id': user.id,
      'conversation_id': _conversationId, // adjust if your var name differs
      'title': title,
      'seed_text': seedText,
      'tags': ['pinned', 'manual'],
      'confidence': 0.95,
    });

    _showSnack('📌 Story pinned');

    // Optional: clear input after pinning
    _textController.clear();
  } catch (e) {
    _showSnack('Failed to pin story');
    debugPrint('❌ pinStorySeed error: $e');
  }
}

  Future<void> _handleSendPressed() async {
    final text = _textController.text.trim();
    _textController.clear();
    if (text.isEmpty) return;

    // For typed text, we always show the user's bubble immediately.
    await _sendTextMessage(text, showUserBubble: true);
  }

String _derivePinnedTitle(String text) {
  final t = text.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (t.isEmpty) return 'Pinned story';
  // Prefer first sentence-ish chunk
  final m = RegExp(r'^(.{1,80}?)([\.!?]|$)').firstMatch(t);
  final candidate = (m?.group(1) ?? t).trim();
  if (candidate.length <= 80) return candidate;
  return '${candidate.substring(0, 77)}...';
}

Future<void> _handlePinPressed() async {
  final user = _client.auth.currentUser;
  if (user == null) {
    _showSnack('Please sign in to pin stories.');
    return;
  }

  final conversationId = _conversationId;
  if (conversationId == null || conversationId.isEmpty) {
    _showSnack('No active session to pin to yet.');
    return;
  }

  // Prefer selected/typed text; fall back to the most recent user message.
  String textToPin = _textController.text.trim();

  if (textToPin.isEmpty) {
    for (final m in _messages.reversed) {
      if (m.isUser && m.text.trim().isNotEmpty) {
        textToPin = m.text.trim();
        break;
      }
    }
  }

  if (textToPin.isEmpty) {
    _showSnack('Nothing to pin yet.');
    return;
  }

  final title = _derivePinnedTitle(textToPin);

  try {
    await _client.from('story_seeds').insert({
      'user_id': user.id,
      'conversation_id': conversationId,
      'title': title,
      'seed_text': textToPin,
      'canonical_facts': <String, dynamic>{},
      'entities': <dynamic>[],
      'tags': <String>['pinned', 'manual'],
      'confidence': 0.95,
      'source_raw_ids': <String>[],
      'source_edit_ids': <String>[],
    });

    // Best-effort: refresh insights for this session so pinned stories surface quickly.
    try {
      await _client.functions.invoke(
        'rebuild-insights',
        body: {
          'user_id': user.id,
          'conversation_id': conversationId,
          'mode': 'session',
        },
      );
    } catch (_) {
      // ignore: avoid_print
      print('rebuild-insights failed after pin (non-fatal)');
    }

    _showSnack('Pinned as a story seed.');
  } catch (e) {
    debugPrint('❌ Pin insert failed: $e');
    _showSnack('Could not pin story (check story_seeds RLS/policies).');
  }
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
    showUserBubble = false;
  }

  if (showUserBubble && trimmed.isNotEmpty) {
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

      stateJson: _mode == 'language_learning'
          ? _languageStateJson
          : _legacyStateJson,

      // ✅ CRITICAL: forward end-session flag through service layer
      endSession: endSession,
    );

    final convId = result['conversation_id'] as String?;
    if (convId != null && convId.isNotEmpty) {
      if (mounted) {
        setState(() => _conversationId = convId);
      } else {
        _conversationId = convId;
      }
    }

    // --- Parse ai-brain response (supports both legacy keys and new contracts) ---
    final bool serverEndSession = (result['end_session'] == true);

    // Prefer reply_text, fallback to text (older service mapping)
    final String aiTextRaw = ((result['reply_text'] ?? result['text']) ?? '').toString();
    var aiText = aiTextRaw.trim();

    // Parse learning artifacts (new contract)
    _learningBlocksCurrent = <_LearningBlock>[];
    final dynamic la = result['learning_artifacts'];
    final dynamic blocks = (la is Map) ? la['blocks'] : null;
    if (blocks is List) {
      _learningBlocksCurrent = blocks
          .where((b) => b is Map)
          .map((b) => _LearningBlock.fromJson(b as Map))
          .where((b) => b.content.trim().isNotEmpty)
          .toList(growable: false);
    }


    // state_json may be a String (JSON) or Map; normalize to String?
    String? newStateJson;
    final dynamic sj = result['state_json'];
    if (sj is String) {
      newStateJson = sj;
    } else if (sj is Map) {
      newStateJson = jsonEncode(sj);
    } else {
      newStateJson = null;
    }

    // NEW DIRECTION: legacy should be free-form; ignore structured chapter routing.
    if (_mode != 'language_learning') {
      // Legacy/avatar: keep state_json as returned (or null). Do NOT force-clear here.
      // (We already avoid using structured chapter routing in UI.)
    }

    // If end-session, do NOT add an AI chat bubble by default.
    if (endSession || serverEndSession) {
      final dynamic legacyArtifacts = result['legacy_artifacts'];
      Map<String, dynamic>? laMap;
      if (legacyArtifacts is Map) {
        laMap = Map<String, dynamic>.from(legacyArtifacts as Map);
      }
      final dynamic moment = laMap?['insight_moment'] ?? result['insight_moment'];
      final dynamic summary = laMap?['end_session_summary'] ?? result['end_session_summary'];

      // Only show the "big reveal" UI if we actually have something to show.
      final bool hasMoment = moment is Map && moment.isNotEmpty;
      final bool hasSummary = summary is Map && summary.isNotEmpty;

      final String convIdForReview =
          ((result['conversation_id'] ?? _conversationId) ?? '').toString();

      // Prefer opening the Session Review screen. If the DB row hasn't landed yet,
      // fall back to the existing reveal sheet so the donor still sees something.
      bool opened = false;
      if (mounted && convIdForReview.trim().isNotEmpty) {
        opened = await _openLatestSessionReviewAfterEndSession(
          conversationId: convIdForReview,
          endSessionSummary: hasSummary ? Map<String, dynamic>.from(summary as Map) : null,
          insightMoment: hasMoment ? Map<String, dynamic>.from(moment as Map) : null,
        );
      }

      if (!opened) {
        if (hasMoment || hasSummary) {
          if (mounted) {
            await _showEndSessionRevealSheet(
              insightMoment:
                  hasMoment ? Map<String, dynamic>.from(moment as Map) : null,
              endSessionSummary:
                  hasSummary ? Map<String, dynamic>.from(summary as Map) : null,
            );
          }
        } else {
          _showSnack("Session saved.");
        }
      }

      // Persist state_json update (legacy cleared / language kept) and return.
      if (_mode == 'language_learning') {
        _languageStateJson = newStateJson;
      } else {
        _legacyStateJson = newStateJson;
      }
      return;
    }
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
    if (mounted) setState(() => _isSending = false);
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
        setState(() => _isTranscribing = true);
      }

      // Mode + language routing
      final mode = _mode; // 'legacy' | 'language_learning' | 'avatar'
      final primaryCode = (mode == 'language_learning') ? _sttLanguageCode : _preferredLocale;

      // Allow alternate languages ONLY in language_learning mode.
      // In legacy/avatar/etc, listen exclusively in L1 to avoid cross-language mis-detection.
      final altCodes = <String>{};
      if (mode == 'language_learning') {
        final pref = _preferredLocale.trim();
        final targ = (_targetLocale ?? '').trim();

        if (pref.isNotEmpty && pref != primaryCode) altCodes.add(pref);
        if (targ.isNotEmpty && targ != primaryCode) altCodes.add(targ);
      }
final sttRes = await _client.functions.invoke(
        'speech-to-text',
        body: {
          'user_id': user.id,
          'audio_base64': base64Audio,
          'mime_type': 'audio/aac',
          'language_code': primaryCode,
          'alt_language_codes': altCodes.toList(),
        },
      );

      final data = sttRes.data;

      if (data is Map && data['error'] != null) {
        _showSnack('STT error: ${data['error']}');
        return;
      }

      final transcript = (data is Map) ? (data['transcript'] as String?) : null;
      if (transcript == null || transcript.trim().isEmpty) {
        _showSnack('No transcript returned.');
        return;
      }

      final trimmedTranscript = transcript.trim();
      if (!mounted) return;

      debugPrint(
        'STT routing → mode=$mode (primary=$primaryCode, alt=${altCodes.toList()})',
      );

      // Push transcript into the text box (user can edit if desired).
      setState(() {
        _textController.text = trimmedTranscript;
        _textController.selection = TextSelection.fromPosition(
          TextPosition(offset: _textController.text.length),
        );
      });

      // Auto-send STT to Gemini in ALL modes (including legacy).
      // (Transcript is still placed in the text box first for visibility.)
      await _handleSendPressed();
      
    } catch (e, st) {
      debugPrint('STT error: $e\n$st');
      _showSnack('Failed to transcribe audio: $e');
    } finally {
      if (mounted) {
        setState(() => _isTranscribing = false);
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
      final prompt = buildPhotoFollowupPrompt(
        isLanguageLearningMode: _isLanguageLearningMode,
        preferredLocale: _preferredLocale,
        targetLocale: targetLocale,
        internalDescription: desc,
      );

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
      final prompt = buildVideoFollowupPrompt(
        isLanguageLearningMode: _isLanguageLearningMode,
        preferredLocale: _preferredLocale,
        targetLocale: targetLocale,
        internalDescription: desc,
      );

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
      resizeToAvoidBottomInset: false,
      appBar: AppBar(
        title: Text(kLegacyOnly ? 'Legacy' : (_mode == 'avatar' ? 'Avatar' : 'Legacy')),
        actions: [
          if (kDebugMode)
            IconButton(
              icon: const Icon(Icons.bug_report),
              tooltip: 'Run diagnostics',
              onPressed: _runDiagnostics,
            ),

          // Conversation mode picker (hidden in Legacy v1)
          if (!kLegacyOnly)
            IconButton(
              icon: const Icon(Icons.tune),
              tooltip: 'Change conversation mode',
              onPressed: _showModePicker,
            ),

          // Learning Hub (language-learning)
          if (_mode == 'language_learning')
            IconButton(
              icon: const Icon(Icons.school),
              tooltip: 'Learning hub',
              onPressed: _openLearningHub,
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
                  value: _MainMenuAction.sessionHistory,
                  child: Text('Session history'),
                ),
                const PopupMenuItem<_MainMenuAction>(
                  value: _MainMenuAction.sessionReview,
                  child: Text('Session Review (latest)'),
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
              if (false) {
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
          if (!kLegacyOnly && _isLanguageLearningMode)
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
      body: SafeArea(
        top: false,
        child: Column(
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
          AnimatedPadding(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOut,
            padding: EdgeInsets.only(
              bottom: MediaQuery.of(context).viewInsets.bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _buildMediaToolbar(),
                _buildInputBar(theme),
              ],
            ),
          ),
        ],
      ),
    ));
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
        if (match != null) return line.substring(match.end);
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
            IconButton(
              tooltip: 'Just here (presence)',
              onPressed: _isSending
                  ? null
                  : () async {
                      await _sendTextMessage(
                        "__PRESENCE__",
                        showUserBubble: false,
                        endSession: false,
                      );
                    },
              icon: Icon(
                Icons.self_improvement,
                color: _isSending ? theme.disabledColor : theme.colorScheme.primary,
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
              icon: const Icon(Icons.push_pin),
              tooltip: 'Pin as story seed',
              onPressed: _pinStorySeed,
            ),

            const SizedBox(width: 4),

            IconButton(
              onPressed: _isSending ? null : _handleSendPressed,
              icon: _isSending
                ? const SizedBox(
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

  // ---------------------------------------------------------------------------
// End Session: "Before you go" reveal sheet
// ---------------------------------------------------------------------------

  // ===========================================================================
  // END SESSION → OPEN SESSION REVIEW (StoryDetailScreen)
  // ===========================================================================
  // We keep latency minimal: only runs after explicit "End Session".
  // Retries briefly because the memory_summary row may land a moment after ai-brain returns.
  Future<bool> _openLatestSessionReviewAfterEndSession({
    required String conversationId,
    dynamic endSessionSummary,
    dynamic insightMoment,
  }) async {
    if (conversationId.trim().isEmpty) return false;

    Map<String, dynamic>? row;

    for (int attempt = 0; attempt < 6; attempt++) {
      try {
        final res = await _client
            .from('memory_summary')
            .select('id, created_at, short_summary, observations, session_insights')
            .eq('conversation_id', conversationId)
            .order('created_at', ascending: false)
            .limit(1);

        if (res is List && res.isNotEmpty && res.first is Map) {
          row = Map<String, dynamic>.from(res.first as Map);
          break;
        }
      } catch (_) {
        // ignore; we'll retry a few times
      }

      // brief backoff (total ~1.5s)
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }

    if (!mounted) return false;

    // If still not found, we can fall back to existing reveal sheet.
    if (row == null) return false;

    final memorySummaryId = (row['id'] ?? '').toString().trim();
    final createdAt = (row['created_at'] ?? '').toString().trim();

    // Canonical summaries come from session_insights; plain columns are mirrors.
    final si = _parseJsonMap(row['session_insights'])
        ?? (endSessionSummary is Map ? _parseJsonMap(endSessionSummary['session_insights']) : null)
        ?? (endSessionSummary is Map ? _parseJsonMap(endSessionSummary) : null);

    final shortSummary = _pickSummaryFromSessionInsights(si, full: false);
    final fullSummary = _pickSummaryFromSessionInsights(si, full: true);

    final obs = row['observations'];
    String? sessionKey;
    if (obs is Map && obs['session_key'] != null) {
      sessionKey = obs['session_key'].toString();
    } else {
      sessionKey = null;
    }

        final sessionInsights = si ?? const <String, dynamic>{};

    // Basic label; StoryDetailScreen can show full timestamps too.
    final dateLabel = createdAt.isNotEmpty ? createdAt : 'Session Review';

    // Cache args so the user can re-open this Session Review later.
    _lastSessionReviewNavArgs = {
      'memorySummaryId': memorySummaryId.isNotEmpty ? memorySummaryId : 'n/a',
      'sessionKey': (sessionKey ?? ''),
      'dateLabel': dateLabel,
      'fallbackTitle': 'Session Review',
      'fallbackBody': (fullSummary.isNotEmpty
              ? fullSummary
              : (shortSummary.isNotEmpty ? shortSummary : '')).trim(),
      'shortSummary': shortSummary,
      'fullSummary': fullSummary,
      'sessionInsights': sessionInsights,
    };


    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => EndSessionReviewScreen(
          memorySummaryId: memorySummaryId.isNotEmpty ? memorySummaryId : 'n/a',
          sessionKey: (sessionKey ?? ''),
          dateLabel: dateLabel,
          fallbackTitle: 'Session Review',
          fallbackBody: (fullSummary.isNotEmpty
                  ? fullSummary
                  : (endSessionSummary is Map && endSessionSummary['full_summary'] != null
                      ? endSessionSummary['full_summary'].toString()
                      : ''))
              .trim(),
          shortSummary: shortSummary,
          fullSummary: fullSummary,
          sessionInsights: sessionInsights,
        ),
      ),
    );

    return true;
  }

Future<void> _showEndSessionRevealSheet({
  Map<String, dynamic>? insightMoment,
  Map<String, dynamic>? endSessionSummary,
}) async {
  if (!mounted) return;

  // If there's literally nothing to show, don't present a reveal UI.
  final hasMoment = insightMoment != null && insightMoment.isNotEmpty;
  final hasSummary = endSessionSummary != null && endSessionSummary.isNotEmpty;
  if (!hasMoment && !hasSummary) {
    _showSnack('Session saved.');
    return;
  }

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Theme.of(context).scaffoldBackgroundColor,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (ctx) {
      final header = (insightMoment?['header'] as String?)?.trim();
      final bodyList = insightMoment?['body'];
      final footnote = (insightMoment?['footnote'] as String?)?.trim();

      final bodyLines = (bodyList is List)
          ? bodyList.map((e) => e?.toString() ?? '').where((s) => s.trim().isNotEmpty).toList()
          : <String>[];

      return SafeArea(
        child: Padding(
          padding: EdgeInsets.only(
            left: 16,
            right: 16,
            top: 14,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
          ),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Before you go…',
                  style: Theme.of(ctx).textTheme.titleLarge,
                ),
                const SizedBox(height: 10),

                if (hasMoment) ...[
                  Text(
                    (header?.isNotEmpty == true) ? header! : 'Something is becoming clearer',
                    style: Theme.of(ctx).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 10),
                  for (final line in bodyLines) ...[
                    Text(line, style: Theme.of(ctx).textTheme.bodyMedium),
                    const SizedBox(height: 8),
                  ],
                  if (footnote?.isNotEmpty == true) ...[
                    const SizedBox(height: 6),
                    Text(footnote!, style: Theme.of(ctx).textTheme.bodySmall),
                  ],
                  const SizedBox(height: 14),
                ],

                if (hasSummary) ...[
                  _buildEndSessionSummaryBlock(ctx, endSessionSummary!),
                  const SizedBox(height: 14),
                ],

                Row(
                  children: [
                    Expanded(
                      child: ElevatedButton(
                        onPressed: () => Navigator.of(ctx).pop(),
                        child: const Text('Done'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

Widget _buildEndSessionSummaryBlock(BuildContext ctx, Map<String, dynamic> summary) {
  String pickString(String key) {
    final v = summary[key];
    return v is String ? v.trim() : '';
  }

  final si = _parseJsonMap(summary['session_insights']) ?? _parseJsonMap(summary);
  final shortSummary = _pickSummaryFromSessionInsights(si, full: false);
  final fullSummary = _pickSummaryFromSessionInsights(si, full: true);

  // Some schemas use these as strings or lists—handle both safely.
  final observations = summary['observations'];
  final sessionInsights = summary['session_insights'];

  String normalizeListish(dynamic v) {
    if (v == null) return '';
    if (v is String) return v.trim();
    if (v is List) {
      final lines = v.map((e) => e?.toString().trim() ?? '').where((s) => s.isNotEmpty).toList();
      return lines.join('\n• ');
    }
    if (v is Map) return jsonEncode(v);
    return v.toString();
  }

  final obsText = normalizeListish(observations);
  final insText = normalizeListish(sessionInsights);

  Widget section(String title, String body) {
    if (body.trim().isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(ctx).textTheme.titleSmall),
          const SizedBox(height: 6),
          Text(body, style: Theme.of(ctx).textTheme.bodyMedium),
        ],
      ),
    );
  }

  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (shortSummary.isNotEmpty)
        section('What we captured today', shortSummary),
      if (fullSummary.isNotEmpty)
        section('More detail', fullSummary),
      if (obsText.isNotEmpty)
        section('Notes', obsText.startsWith('• ') ? obsText : '• $obsText'),
      if (insText.isNotEmpty)
        section('What may be worth noticing', insText.startsWith('• ') ? insText : '• $insText'),
    ],
  );
}
}

// ============================================================================
// COVERAGE MAP SCREEN
// ============================================================================


// ===========================================================================
// Learning Hub UI (donor-wide history + search)
// ===========================================================================

class _LearningBlock {
  final String? id;
  final String tag;
  final String? title;
  final String content;

  final dynamic rawJson;

  const _LearningBlock({
    this.id,
    required this.tag,
    required this.content,
    this.title,
    this.rawJson,
  });

  factory _LearningBlock.fromJson(Map<dynamic, dynamic> json) {
    return _LearningBlock(
      id: json['id']?.toString(),
      tag: (json['tag'] ?? '').toString(),
      title: json['title']?.toString(),
      content: (json['content'] ?? '').toString(),
      rawJson: json['raw_json'] ?? json['rawJson'],
    );
  }
}

class _ReviewCard {
  final String l2;
  final String? romanization;
  final String? meaning;
  final String? notes;
  final DateTime? updatedAt;

  const _ReviewCard({
    required this.l2,
    this.romanization,
    this.meaning,
    this.notes,
    this.updatedAt,
  });

  factory _ReviewCard.fromJson(Map<dynamic, dynamic> json) {
    DateTime? dt;
    final raw = json['updated_at'] ?? json['updatedAt'];
    if (raw is String && raw.isNotEmpty) {
      dt = DateTime.tryParse(raw);
    }
    return _ReviewCard(
      l2: (json['l2'] ?? '').toString(),
      romanization: (json['romanization'] ?? '').toString().trim().isEmpty
          ? null
          : (json['romanization'] ?? '').toString().trim(),
      meaning: (json['meaning'] ?? '').toString().trim().isEmpty
          ? null
          : (json['meaning'] ?? '').toString().trim(),
      notes: (json['notes'] ?? '').toString().trim().isEmpty
          ? null
          : (json['notes'] ?? '').toString().trim(),
      updatedAt: dt,
    );
  }
}

class _LearningSessionSummary {
  final String id;
  final DateTime createdAt;
  final Map<String, int> counts;

  /// Optional human-friendly preview shown in the History list (derived from the
  /// first block in the session, if available).
  final String preview;

  /// Back-compat alias (older UI code used countsByTag)
  Map<String, int> get countsByTag => counts;

  const _LearningSessionSummary({
    required this.id,
    required this.createdAt,
    required this.counts,
    this.preview = '',
  });

  factory _LearningSessionSummary.fromJson(Map<dynamic, dynamic> json) {
    final created = DateTime.tryParse((json['created_at'] ?? '').toString()) ?? DateTime.fromMillisecondsSinceEpoch(0);
    final countsRaw = json['counts_by_tag'];
    final counts = <String, int>{};
    if (countsRaw is Map) {
      for (final e in countsRaw.entries) {
        final v = int.tryParse(e.value.toString()) ?? 0;
        counts[e.key.toString()] = v < 0 ? 0 : v;
      }
    }
    return _LearningSessionSummary(
      id: (json['id'] ?? '').toString(),
      createdAt: created,
      counts: counts,
      preview: (json['preview'] ?? '').toString(),
    );
  }
}

class _LearningHubScreen extends StatefulWidget {
  final SupabaseClient client;
  final String userId;
  final List<_LearningBlock> currentBlocks;


  final String preferredLocale;
  final String? targetLocale;
  final String? conversationId;

  final Future<void> Function(String text, String locale)? onSpeakL2;

  const _LearningHubScreen({
    super.key,
    required this.client,
    required this.userId,
    required this.currentBlocks,
    required this.preferredLocale,
    this.targetLocale,
    this.conversationId,
    this.onSpeakL2,
  });

  @override
  State<_LearningHubScreen> createState() => _LearningHubScreenState();
}

class _LearningHubScreenState extends State<_LearningHubScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  final TextEditingController _searchCtl = TextEditingController();
  String _tagFilter = 'ALL';
  bool _loading = false;

  List<_LearningSessionSummary> _sessions = const [];
  List<Map<String, dynamic>> _searchHits = const [];

  List<_LearningBlock> _currentBlocksDb = const [];
  bool _loadingCurrent = false;


  // Review (flashcards) — phrase cache only (no Gemini calls)
  bool _loadingReview = false;
  List<_ReviewCard> _reviewCards = const [];
  final Set<String> _revealedReview = <String>{};

  // Lightweight local phrase cache for UI enrichment (no Gemini calls)
  final Map<String, Map<String, String>> _phraseCacheByL2 = <String, Map<String, String>>{};
  final Set<String> _needsEnrichmentL2 = <String>{};
  String _reviewFilter = 'NEW'; // NEW | LEARNING | MASTERED | DUE | ALL

  String get tl => (widget.targetLocale ?? '').trim();
  final Map<String, int> _reviewStatus = <String, int>{}; // key -> 0/1/2
  final Map<String, Map<String, dynamic>> _reviewSchedule = <String, Map<String, dynamic>>{}; // key -> {due_ms, interval_ms, ease}

  // Legacy enrichment helper (currently hidden in UI).
  final Set<String> _enrichingBlockIds = <String>{};

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this, initialIndex: 0); // default to History
    _tabController.addListener(() {
      if (_tabController.indexIsChanging) return;
      if (_tabController.index == 2) {
        if (_reviewCards.isEmpty && !_loadingReview) {
          _loadReviewCards();
        }
      }
    });
    _loadReviewStatus();
    _loadReviewSchedule();
    _loadRecentSessions();
    _loadCurrentFromConversationIfPossible();
  }

  @override
  void didUpdateWidget(covariant _LearningHubScreen oldWidget) {
    super.didUpdateWidget(oldWidget);

    // If parent passed new blocks for "This session", prime cache so this tab can mirror Review.
    if (widget.currentBlocks != oldWidget.currentBlocks && widget.currentBlocks.isNotEmpty) {
      _seedPhraseCacheFromBlocks(widget.currentBlocks);
      _primePhraseCacheForL2(_collectL2FromBlocks(widget.currentBlocks));
    }

    // Locale changes can affect which cache rows we should show.
    if ((widget.targetLocale ?? '').trim() != (oldWidget.targetLocale ?? '').trim()) {
      _loadReviewCards();
      _loadRecentSessions();
    }
  }


  @override
  void dispose() {
    _tabController.dispose();
    _searchCtl.dispose();
    super.dispose();
  }

  Future<void> _loadRecentSessions() async {
    setState(() => _loading = true);
    try {
      dynamic res;

      // Prefer RPC (fast + server-side aggregation) but pass user id if the function supports it.
      try {
        res = await widget.client.rpc('list_learning_sessions', params: {
          'p_user_id': widget.userId,
          'p_limit': 50,
          'p_offset': 0,
        });
      } catch (_) {
        // Backward-compat: older SQL function may not accept p_user_id.
        res = await widget.client.rpc('list_learning_sessions', params: {
          'p_limit': 50,
          'p_offset': 0,
        });
      }

      // If RPC returns something unexpected or empty, fall back to a direct table query.
      List<_LearningSessionSummary> sessions = const [];
      if (res is List) {
        sessions = _parseSessionSummaries(res);

        sessions = await _hydrateSessionCountsIfMissing(sessions);
        sessions = await _hydrateSessionPreviewsIfMissing(sessions);
      }

      if (sessions.isEmpty) {
        final data = await widget.client
            .from('learning_sessions')
            .select('id, created_at, counts_by_tag')
            .eq('user_id', widget.userId)
            .order('created_at', ascending: false)
            .limit(50);

        sessions = _parseSessionSummaries(data);

        sessions = await _hydrateSessionCountsIfMissing(sessions);
        sessions = await _hydrateSessionPreviewsIfMissing(sessions);
      }

      setState(() {
        _sessions = sessions;
      });
    } catch (e, st) {
      debugPrint('❌ Learning Hub history load failed: $e\n$st');

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Learning History error: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  

  Future<void> _loadCurrentFromConversationIfPossible() async {
    // "This session" should show multiple learning items, not just the last turn.
    // We aggregate blocks across recent learning_sessions for the current conversation when possible.
    final convId = widget.conversationId;

    if (_loadingCurrent) return;
    setState(() => _loadingCurrent = true);
    try {
      List<String> sessionIds = const [];

      if (convId != null && convId.isNotEmpty) {
        final data = await widget.client
            .from('learning_sessions')
            .select('id, created_at')
            .eq('conversation_id', convId)
            .order('created_at', ascending: false)
            .limit(25);

        final list = (data is List) ? data : const [];
        sessionIds = list
            .whereType<Map>()
            .map((m) => (m['id'] ?? '').toString())
            .where((s) => s.isNotEmpty)
            .toList(growable: false);
      }

      // Fallback: if no conversation id (or none found), show recent sessions for this user.
      if (sessionIds.isEmpty) {
        final data = await widget.client
            .from('learning_sessions')
            .select('id, created_at')
            .eq('user_id', widget.userId)
            .order('created_at', ascending: false)
            .limit(15);

        final list = (data is List) ? data : const [];
        sessionIds = list
            .whereType<Map>()
            .map((m) => (m['id'] ?? '').toString())
            .where((s) => s.isNotEmpty)
            .toList(growable: false);
      }

      if (sessionIds.isEmpty) {
        if (mounted) setState(() => _currentBlocksDb = const []);
        return;
      }

      // Load all blocks across those sessions in one batched call.
      final blocks = await _loadBlocksForSessions(sessionIds.reversed.toList()); // oldest->newest
      if (mounted) setState(() => _currentBlocksDb = blocks);
      // Seed from structured blocks first (covers items that haven't been cached in DB yet).
      _seedPhraseCacheFromBlocks(blocks);
      // Normalize legacy VOCAB raw_json to include items[] so all tabs stay consistent.
      // Don't await (avoid UI latency).
      // ignore: discarded_futures
      Future(() => _normalizeVocabBlocksIfNeeded(blocks));
      // Best-effort: fetch cached romanization/meaning so This session shows richer lines without any Gemini calls.
      await _primePhraseCacheForL2(_collectL2FromBlocks(blocks));
      if (mounted) setState(() {});
    } catch (e) {
      debugPrint('⚠️ loadCurrentFromConversation failed: $e');
    } finally {
      if (mounted) setState(() => _loadingCurrent = false);
    }
  }


  Future<List<_LearningBlock>> _loadBlocksForSession(String sessionId) async {
    final data = await widget.client
        .from('learning_blocks')
        .select('id, session_id, idx, tag, title, content, raw_json, created_at')
        .eq('session_id', sessionId)
        .order('idx', ascending: true);

    final list = (data is List) ? data : const [];
    final out = <_LearningBlock>[];
    for (final r in list) {
      if (r is! Map) continue;
      out.add(_LearningBlock.fromJson(Map<String, dynamic>.from(r)));
    }
    return out;
  }

  Future<List<_LearningBlock>> _loadBlocksForSessions(List<String> sessionIds) async {
    final ids = sessionIds.where((s) => s.trim().isNotEmpty).toList();
    if (ids.isEmpty) return const <_LearningBlock>[];

    final data = await widget.client
        .from('learning_blocks')
        .select('id, session_id, idx, tag, title, content, raw_json, created_at')
        .inFilter('session_id', ids)
        .order('created_at', ascending: true)
        .order('idx', ascending: true);

    final list = (data is List) ? data : const [];
    final out = <_LearningBlock>[];
    for (final r in list) {
      if (r is! Map) continue;
      out.add(_LearningBlock.fromJson(Map<String, dynamic>.from(r)));
    }
    return out;
  }


  // ---------------------------------------------------------------------------
  // On-demand enrichment (zero extra calls during normal turns)
  // - Only runs when the user taps "Add details" in the Learning Hub.
  // - Caches by updating learning_blocks.raw_json in Supabase via ai-brain op routing.
  // ---------------------------------------------------------------------------

  bool _blockNeedsEnrichment(_LearningBlock b) {
    final tag = (b.tag).toUpperCase().trim();
    if (tag != 'VOCAB') return false;

    final raw = b.rawJson;
    if (raw is Map) {
      final items = raw['items'];
      if (items is List && items.isNotEmpty) {
        bool hasMissing = false;
        for (final it in items) {
          if (it is Map) {
            final rom = (it['romanization'] ?? it['ipa'] ?? '').toString().trim();
            final meaning = (it['meaning'] ?? it['english'] ?? '').toString().trim();
            if (rom.isEmpty || meaning.isEmpty) {
              hasMissing = true;
              break;
            }
          } else if (it is String) {
            // plain strings imply not enriched
            hasMissing = true;
            break;
          }
        }
        return hasMissing;
      }
    }

    // No structured items present: allow enrichment using content fallback parsing
    return true;
  }

  Future<_LearningBlock?> _enrichLearningBlockOnDemand(_LearningBlock b) async {
    final blockId = b.id;
    if (blockId == null || blockId.isEmpty) return null;

    final payload = <String, dynamic>{
      'op': 'enrich_learning_block',
      'user_id': widget.userId,
      'block_id': blockId,
      'preferred_locale': widget.preferredLocale,
      'target_locale': widget.targetLocale,
      // required by the existing ai-brain payload schema, but ignored for op routing:
      'message_text': '',
      'mode': 'language_learning',
      // optional hints (ai-brain defaults safely if missing)
      'preferred_locale': 'en',
      'target_locale': 'th-TH',
    };

    final res = await widget.client.functions.invoke('ai-brain', body: payload);
    final data = res.data;
    if (data is! Map) return null;

    final rawJson = data['raw_json'];
    final content = (data['content'] ?? b.content).toString();

    return _LearningBlock(
      id: b.id,
      tag: b.tag,
      title: b.title,
      content: content,
      rawJson: rawJson,
    );
  }



  String _formatShortDateTime(DateTime dt) {
    final local = dt.toLocal();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
  }

  String _inferLocaleForSpeak(String l2Text) {
    final t = l2Text.trim();
    if (tl.isNotEmpty) return tl;
    if (t.isEmpty) return widget.preferredLocale;
    if (RegExp(r'[\u0E00-\u0E7F]').hasMatch(t)) return 'th-TH';
    return widget.preferredLocale;
  }

  Future<void> _openSessionDetails(_LearningSessionSummary s) async {
    try {
      final blocks = await _loadBlocksForSession(s.id);
      // Seed cache from this session's structured items so details match Review.
      _seedPhraseCacheFromBlocks(blocks);
      // Normalize legacy VOCAB raw_json to include items[] (best effort, no Gemini calls).
      // ignore: discarded_futures
      Future(() => _normalizeVocabBlocksIfNeeded(blocks));
      if (!mounted) return;

      await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (ctx) {
          List<_LearningBlock> localBlocks = List<_LearningBlock>.from(blocks);

          return StatefulBuilder(
            builder: (ctx, setModalState) {
              return SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _formatShortDateTime(s.createdAt),
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 10),
                  if (localBlocks.isEmpty)
                    const Text('No learning items found for this session.')
                  else
                    Flexible(
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: localBlocks.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 10),
                        itemBuilder: (_, i) {
                          final b = localBlocks[i];
                          final tag = (b.tag).trim();
                          final title = (b.title ?? '').trim();
                          final header = [
                            if (tag.isNotEmpty) tag,
                            if (title.isNotEmpty) title,
                          ].join(' · ');
                          return Card(
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  if (header.isNotEmpty)
                                    Text(header, style: const TextStyle(fontWeight: FontWeight.w600)),
                                  const SizedBox(height: 8),
                                  Text(_renderBlockContent(b)),

                if (false) // UI removed: no more on-demand enrichment button
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                      onPressed: _enrichingBlockIds.contains(b.id)
                          ? null
                          : () async {
                              final bid = b.id!;
                              setState(() => _enrichingBlockIds.add(bid));
                              try {
                                final updated = await _enrichLearningBlockOnDemand(b);
                                if (updated != null) {
                                  // Refresh current + history so the details and previews appear immediately.
                                  await _loadCurrentFromConversationIfPossible();
                                  await _loadRecentSessions();
                                }
                              } finally {
                                if (mounted) {
                                  setState(() => _enrichingBlockIds.remove(bid));
                                }
                              }
                            },
                      icon: _enrichingBlockIds.contains(b.id)
                          ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.auto_fix_high),
                      label: const Text('Add details'),
                    ),
                  ),
                Text(_renderBlockContent(b)),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          );
            },
          );
        },
      );
    } catch (e) {
      debugPrint('⚠️ openSessionDetails failed: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to load session: $e')),
        );
      }
    }
  }

  String _humanizeBlockContent(String content) {
    final c = content.trim();
    if (c.isEmpty) return c;

    // If content already looks like a numbered list, render as-is.
    // Otherwise, keep it as plain text.
    return c;
  }


  String _buildHistoryPreviewText({
    required String tag,
    required String title,
    required String content,
    required dynamic rawJson,
  }) {
    final t = tag.trim().toUpperCase();

    // VOCAB: try to show "Thai — meaning" if available.
    if (t == 'VOCAB' && rawJson is Map) {
      final items = rawJson['items'];
      if (items is List && items.isNotEmpty) {
        final it0 = items.first;
        if (it0 is Map) {
          final l2 = (it0['l2'] ?? it0['thai'] ?? it0['text'] ?? '').toString().trim();
          final meaning = (it0['meaning'] ?? it0['english'] ?? '').toString().trim();
          final rom = (it0['romanization'] ?? it0['ipa'] ?? '').toString().trim();

          if (l2.isNotEmpty && meaning.isNotEmpty) {
            return '$l2 — $meaning';
          }
          if (l2.isNotEmpty && rom.isNotEmpty) {
            return '$l2 ($rom)';
          }
          if (l2.isNotEmpty) return l2;
        } else if (it0 != null) {
          final s = it0.toString().trim();
          if (s.isNotEmpty) return s;
        }
      }
    }

    // Otherwise, use title or first line of content.
    final titleClean = title.trim();
    if (titleClean.isNotEmpty) return titleClean;

    final c = content.trim();
    if (c.isEmpty) return '';
    final firstLine = c.split('\n').first.trim();
    return firstLine.isNotEmpty ? firstLine : c;
  }



  String _renderBlockPreview(_LearningBlock b) {
    // Single-line preview used in History list rows.
    // No Gemini calls; purely local formatting.
    final full = _renderBlockContent(b).trim();
    if (full.isEmpty) {
      final t = (b.title ?? '').trim();
      if (t.isNotEmpty) return t;
      final c = b.content.trim();
      if (c.isEmpty) return '';
      return c.split('\n').first.trim();
    }

    // Take the first non-empty line and remove leading bullet markers.
    final firstNonEmpty = full
        .split('\n')
        .map((l) => l.trim())
        .firstWhere((l) => l.isNotEmpty, orElse: () => '');

    var line = firstNonEmpty;
    if (line.startsWith('• ')) line = line.substring(2).trim();
    if (line.startsWith('- ')) line = line.substring(2).trim();

    // Clamp to a reasonable length for list subtitles.
    const maxLen = 120;
    if (line.length > maxLen) {
      line = line.substring(0, maxLen).trimRight() + '…';
    }
    return line;
  }



  
List<String> _collectL2FromBlocks(List<_LearningBlock> blocks) {
  // Extract L2 terms/phrases from VOCAB-style blocks WITHOUT any extra Gemini calls.
  // Supports multiple stored shapes:
  //  - raw_json: { items: [ {l2, romanization, meaning, notes, ...}, ... ] }
  //  - raw_json: { tag, title, content, raw_text } where content/raw_text is a numbered list
  //  - fallback to b.content/title
  final out = <String>[];

  void addLine(String s) {
    final t = s.trim();
    if (t.isEmpty) return;

    // Strip "1) " / "1." / "- " / "• " prefixes.
    final cleaned = t
        .replaceFirst(RegExp(r'^\s*[\-\u2022]\s+'), '')
        .replaceFirst(RegExp(r'^\s*\d+\s*[\)\.\-:]\s*'), '')
        .trim();

    if (cleaned.isEmpty) return;
    out.add(cleaned);
  }

  void addFromText(String text) {
    final lines = text.split('\n');
    for (final ln in lines) {
      final l = ln.trim();
      if (l.isEmpty) continue;
      // Avoid capturing headers like "[VOCAB]" or "Auto-captured phrases".
      final up = l.toUpperCase();
      if (up == '[VOCAB]' || up == 'VOCAB' || up == 'AUTO-CAPTURED PHRASES') continue;
      addLine(l);
      if (out.length >= 200) return;
    }
  }

  void extractFromRaw(dynamic raw) {
    if (raw == null) return;

    // raw_json sometimes stored as a JSON string.
    if (raw is String) {
      final s = raw.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          raw = jsonDecode(s);
        } catch (_) {
          // If decode fails, treat as plain text.
          addFromText(s);
          return;
        }
      } else {
        addFromText(s);
        return;
      }
    }

    if (raw is Map) {
      final map = Map<String, dynamic>.from(raw);

      // Primary: items list.
      final items = map['items'];
      if (items is List) {
        for (final it in items) {
          if (it is! Map) continue;
          final m = Map<String, dynamic>.from(it);
          final l2 = (m['l2'] ??
                  m['l2_text'] ??
                  m['l2Text'] ??
                  m['thai'] ??
                  m['text'] ??
                  m['phrase'] ??
                  m['term'] ??
                  m['target'] ??
                  m['target_text'] ??
                  m['targetText'] ??
                  '')
              .toString()
              .trim();
          if (l2.isNotEmpty) addLine(l2);
          if (out.length >= 200) return;
        }
        return;
      }

      // Secondary: VOCAB meta shape with content/raw_text.
      final content = (map['content'] ?? map['raw_text'] ?? map['rawText'] ?? '').toString();
      if (content.trim().isNotEmpty) {
        addFromText(content);
        return;
      }

      // Last resort: if there is a "l2" field at top-level.
      final l2 = (map['l2'] ?? map['text'] ?? '').toString().trim();
      if (l2.isNotEmpty) addLine(l2);
      return;
    }

    if (raw is List) {
      for (final it in raw) {
        if (it == null) continue;
        if (it is Map) {
          final m = Map<String, dynamic>.from(it);
          final l2 = (m['l2'] ?? m['thai'] ?? m['text'] ?? '').toString().trim();
          if (l2.isNotEmpty) addLine(l2);
        } else {
          addLine(it.toString());
        }
        if (out.length >= 200) return;
      }
      return;
    }
  }

  for (final b in blocks) {
    // Prefer structured raw_json.
    extractFromRaw(b.rawJson);

    // Fallback: parse block content/title if raw_json didn't yield anything.
    if (out.isEmpty) {
      final c = b.content.trim();
      if (c.isNotEmpty) addFromText(c);
      final t = (b.title ?? '').trim();
      if (t.isNotEmpty) addLine(t);
    }

    if (out.length >= 200) break;
  }

  return out;
}

  Future<void> _primePhraseCacheForL2(List<String> l2s) async {
    final uniq = <String>{};
    for (final s in l2s) {
      final t = s.trim();
      if (t.isEmpty) continue;
      if (_phraseCacheByL2.containsKey(t)) continue;
      uniq.add(t);
      if (uniq.length >= 150) break;
    }
    if (uniq.isEmpty) return;

    try {
      final q = widget.client
          .from('learning_phrase_cache')
          .select('l2, romanization, meaning, notes, target_locale');
      dynamic q2 = q;
      if (tl.isNotEmpty) {
        q2 = q.eq('target_locale', tl);
      }
      final rows = await q2.inFilter('l2', uniq.toList()).limit(200);
      if (rows is! List) return;

      for (final r in rows) {
        if (r is! Map) continue;
        final m = Map<String, dynamic>.from(r);
        final l2 = (m['l2'] ?? '').toString().trim();
        if (l2.isEmpty) continue;
        _phraseCacheByL2[l2] = {
          'romanization': (m['romanization'] ?? '').toString().trim(),
          'meaning': (m['meaning'] ?? '').toString().trim(),
          'notes': (m['notes'] ?? '').toString().trim(),
        };
      }
    } catch (_) {}
  }


  
  Future<void> _normalizeVocabBlocksIfNeeded(List<_LearningBlock> blocks) async {
    // Goal: make legacy VOCAB blocks consistent by ensuring raw_json includes items[].
    // No Gemini calls. We only write back what we can derive locally from content/raw_text.
    final nowIso = DateTime.now().toUtc().toIso8601String();

    for (final b in blocks) {
      final id = b.id?.trim();
      if (id == null || id.isEmpty) continue;
      if (b.tag.toUpperCase() != 'VOCAB') continue;

      dynamic raw = b.rawJson;

      // raw_json may be a JSON string.
      if (raw is String) {
        final s = raw.trim();
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
          try {
            raw = jsonDecode(s);
          } catch (_) {}
        }
      }

      // If already has items[], nothing to do.
      if (raw is Map) {
        final map = Map<String, dynamic>.from(raw);
        if (map['items'] is List) continue;

        // Extract L2 lines and build minimal items[]
        final l2s = _collectL2FromBlocks([b]);
        if (l2s.isEmpty) continue;

        final items = l2s.map((l2) => <String, dynamic>{'l2': l2}).toList();

        final next = <String, dynamic>{
          ...map,
          'items': items,
          'enriched_at': map['enriched_at'] ?? nowIso,
          'enriched_via': map['enriched_via'] ?? 'client_seed',
        };

        try {
          await widget.client.from('learning_blocks').update({'raw_json': next}).eq('id', id);
        } catch (e) {
          debugPrint('⚠️ normalize VOCAB raw_json failed (id=$id): $e');
        }
      } else {
        // If raw_json isn't a map, we still can seed placeholders but we won't overwrite DB blindly.
        // (Avoids surprising schema changes.)
        continue;
      }
    }
  }

void _seedPhraseCacheFromBlocks(List<_LearningBlock> blocks) {
    // Seed phrase cache directly from structured raw_json items when available.
    // Also "normalize" legacy VOCAB block shapes (tag/title/content/raw_text without items)
    // by extracting the L2 terms so the UI can behave consistently. No Gemini calls.
    for (final b in blocks) {
      dynamic raw = b.rawJson;

      // raw_json may be stored as a JSON string.
      if (raw is String) {
        final s = raw.trim();
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
          try {
            raw = jsonDecode(s);
          } catch (_) {
            // ignore
          }
        }
      }

      // 1) Preferred: raw_json.items[] shape.
      if (raw is Map) {
        final map = Map<String, dynamic>.from(raw);

        final items = map['items'];
        if (items is List) {
          for (final item in items) {
            if (item is! Map) continue;
            final m = Map<String, dynamic>.from(item);

            final l2 = ((m['l2'] ??
                        m['thai'] ??
                        m['text'] ??
                        m['phrase'] ??
                        m['term'] ??
                        m['target'] ??
                        m['target_text'] ??
                        m['targetText'] ??
                        '')
                    .toString())
                .trim();
            if (l2.isEmpty) continue;

            final rom = (m['romanization'] ?? m['rom'] ?? m['roman'] ?? '').toString().trim();
            final meaning = (m['meaning'] ?? m['english'] ?? m['translation'] ?? '').toString().trim();
            final notes = (m['notes'] ?? m['explanation'] ?? m['hint'] ?? '').toString().trim();

            // Merge with any existing cached data (DB rows should win if already present).
            final existing = _phraseCacheByL2[l2] ?? const <String, String>{};
            String pick(String a, String b) => a.trim().isNotEmpty ? a.trim() : b.trim();

            _phraseCacheByL2[l2] = {
              'romanization': pick(existing['romanization'] ?? '', rom),
              'meaning': pick(existing['meaning'] ?? '', meaning),
              'notes': pick(existing['notes'] ?? '', notes),
            };

            // Mark missing meta so UI can show "needs enrichment" consistently.
            if ((rom + meaning + notes).trim().isEmpty) {
              _needsEnrichmentL2.add(l2);
            } else {
              _needsEnrichmentL2.remove(l2);
            }
          }
          continue;
        }
      }

      // 2) Legacy/fallback VOCAB shapes: extract L2 lines from content/raw_text and seed placeholders.
      final l2s = _collectL2FromBlocks([b]);
      for (final l2 in l2s) {
        if (l2.trim().isEmpty) continue;
        _phraseCacheByL2.putIfAbsent(l2, () => <String, String>{'romanization': '', 'meaning': '', 'notes': ''});
        _needsEnrichmentL2.add(l2);
      }
    }
  }



  String _renderBlockContent(_LearningBlock b) {
    // Prefer structured raw_json (no extra Gemini calls; purely local formatting).
    dynamic raw = b.rawJson;

    // Sometimes raw_json is stored as a JSON string.
    if (raw is String) {
      final s = raw.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          raw = jsonDecode(s);
        } catch (_) {
          // ignore
        }
      }
    }

    String lineForItem(dynamic item) {
      if (item == null) return '';
      if (item is String) return item.trim();

      if (item is Map) {
        String pick(dynamic v) => (v ?? '').toString().trim();

        final l2 = pick(item['l2'] ?? item['thai'] ?? item['text'] ?? item['phrase'] ?? item['term'] ?? item['target']);
        var rom = pick(item['romanization'] ?? item['romaji'] ?? item['ipa'] ?? item['pronunciation']);
        var meaning = pick(item['meaning'] ?? item['english'] ?? item['translation'] ?? item['gloss'] ?? item['l1']);

        // If raw_json lacks enrichment, fall back to our lightweight phrase cache (no Gemini calls).
        if (l2.isNotEmpty) {
          final cached = _phraseCacheByL2[l2];
          if (cached != null) {
            if (rom.isEmpty) rom = (cached['romanization'] ?? '').trim();
            if (meaning.isEmpty) meaning = (cached['meaning'] ?? '').trim();
          }
        }

        final note = pick(item['note'] ?? item['notes'] ?? item['explanation'] ?? item['breakdown']);

        final parts = <String>[];
        if (l2.isNotEmpty) parts.add(l2);
        if (rom.isNotEmpty) parts.add('($rom)');
        if (meaning.isNotEmpty) parts.add('— $meaning');

        var out = parts.join(' ');
        if (note.isNotEmpty) {
          out = out.isEmpty ? '• $note' : '$out\n   • $note';
        }
        return out.trim();
      }

      return item.toString().trim();
    }

    String renderFrom(dynamic obj) {
      if (obj == null) return '';
      if (obj is List) {
        final lines = <String>[];
        var n = 1;
        for (final it in obj) {
          final s = lineForItem(it);
          if (s.isEmpty) continue;
          lines.add('${n++}) $s');
        }
        return lines.join('\n');
      }

      if (obj is Map) {
        // Common shapes
        final items = obj['items'] ?? obj['phrases'] ?? obj['vocab'] ?? obj['entries'] ?? obj['blocks'];
        if (items is List) return renderFrom(items);

        final text = (obj['text'] ?? obj['content'] ?? obj['value'] ?? '').toString().trim();
        if (text.isNotEmpty) return text;

        // If the map itself is an item, render it.
        final one = lineForItem(obj);
        if (one.isNotEmpty) return one;
      }

      return obj.toString().trim();
    }

    final rendered = renderFrom(raw);
    if (rendered.isNotEmpty) return rendered;

    // Fallback: plain content.
    return _humanizeBlockContent(b.content);
  }


  Future<List<_LearningSessionSummary>> _hydrateSessionCountsIfMissing(List<_LearningSessionSummary> sessions) async {
    if (sessions.isEmpty) return sessions;

    final needs = sessions.where((s) => s.counts.isEmpty).toList();
    if (needs.isEmpty) return sessions;

    final ids = sessions.map((s) => s.id).where((s) => s.isNotEmpty).toList();
    if (ids.isEmpty) return sessions;

    try {
      // One batched read. No Gemini calls; low latency.
      final data = await widget.client
          .from('learning_blocks')
          .select('session_id, tag')
          .inFilter('session_id', ids);

      final list = (data is List) ? data : const [];
      final bySession = <String, Map<String, int>>{};

      for (final r in list) {
        if (r is! Map) continue;
        final m = Map<String, dynamic>.from(r);
        final sid = (m['session_id'] ?? '').toString();
        final tag = (m['tag'] ?? '').toString();
        if (sid.isEmpty || tag.isEmpty) continue;

        final map = bySession.putIfAbsent(sid, () => <String, int>{});
        map[tag] = (map[tag] ?? 0) + 1;
      }

      // Rebuild summaries with hydrated counts (leave existing non-empty counts intact).
      return sessions
          .map((s) => s.counts.isNotEmpty
              ? s
              : _LearningSessionSummary(id: s.id, createdAt: s.createdAt, counts: bySession[s.id] ?? const <String, int>{}))
          .toList();
    } catch (e) {
      debugPrint('⚠️ hydrateSessionCounts failed: $e');
      return sessions;
    }
  }

  bool _isPlaceholderPreview(String p) {
    final s = p.trim();
    if (s.isEmpty) return true;
    // Treat terse meta like "VOCAB-1" or "META-2" as placeholders.
    final up = s.toUpperCase();
    final re = RegExp(r'^[A-Z_]+-\d+$');
    if (re.hasMatch(up)) return true;
    // Also treat previews that are only counts/meta markers as placeholders.
    if (up.contains('VOCAB-') || up.contains('META-') || up.contains('BLOCK-')) return true;
    return false;
  }

  Future<List<_LearningSessionSummary>> _hydrateSessionPreviewsIfMissing(List<_LearningSessionSummary> sessions) async {
    if (sessions.isEmpty) return sessions;

    final needs = sessions.toList(); // Always hydrate previews so History is reliably informative (no Gemini calls).
    if (needs.isEmpty) return sessions;

    final ids = sessions.map((s) => s.id).where((s) => s.isNotEmpty).toList();
    if (ids.isEmpty) return sessions;

    try {
      // One batched read. No Gemini calls. We just pick a small preview from existing stored blocks.
      final data = await widget.client
          .from('learning_blocks')
          .select('id, session_id, idx, tag, title, content, raw_json, created_at')
          .inFilter('session_id', ids)
          .order('idx', ascending: true)
          .order('created_at', ascending: true);

      final list = (data is List) ? data : const [];
      final bySession = <String, List<_LearningBlock>>{};
      for (final r in list) {
        if (r is! Map) continue;
        final b = _LearningBlock.fromJson(Map<String, dynamic>.from(r));
        final sid = (r['session_id'] ?? '').toString();
        if (sid.isEmpty) continue;
        (bySession[sid] ??= <_LearningBlock>[]).add(b);
      }
      // Optional: enrich History preview using the phrase cache (no Gemini calls).
      final tl0 = (widget.targetLocale ?? '').trim();
      final l2Set = <String>{};
      
String? _extractFirstVocabL2(List<_LearningBlock> blocks) {
  if (blocks.isEmpty) return null;
  final vocab = blocks.where((b) => (b.tag).toUpperCase().trim() == 'VOCAB').toList();
  final l2s = _collectL2FromBlocks(vocab.isNotEmpty ? vocab : blocks);
  if (l2s.isEmpty) return null;
  return l2s.first.trim().isEmpty ? null : l2s.first.trim();
}
      for (final e in bySession.entries) {
        final l2 = _extractFirstVocabL2(e.value);
        if (l2 != null && l2.isNotEmpty) l2Set.add(l2);
      }
      final cacheByL2 = <String, Map<String, String>>{};
      if (l2Set.isNotEmpty) {
        try {
          dynamic q = widget.client.from('learning_phrase_cache')
              .select('l2, meaning, romanization, notes, target_locale');
          if (tl0.isNotEmpty) {
            q = q.eq('target_locale', tl0);
          }
          final rows = await q.inFilter('l2', l2Set.toList());
          final list2 = (rows is List) ? rows : const [];
          for (final r in list2) {
            if (r is! Map) continue;
            final m = Map<String, dynamic>.from(r);
            final l2 = (m['l2'] ?? '').toString().trim();
            if (l2.isEmpty) continue;
            cacheByL2[l2] = {
              'meaning': (m['meaning'] ?? '').toString().trim(),
              'romanization': (m['romanization'] ?? '').toString().trim(),
              'notes': (m['notes'] ?? '').toString().trim(),
            };
          }
        } catch (_) {
          // Best-effort only; ignore cache lookup failures.
        }
      }


      
String pickPreview(List<_LearningBlock> blocks) {
  if (blocks.isEmpty) return '';

  // Build a compact preview of actual L2 terms for the session (no Gemini calls).
  final vocabBlocks = blocks.where((b) => (b.tag).toUpperCase().trim() == 'VOCAB').toList();
  final rawL2s = _collectL2FromBlocks(vocabBlocks.isNotEmpty ? vocabBlocks : blocks);

  final seen = <String>{};
  final l2s = <String>[];
  for (final s in rawL2s) {
    final t = s.trim();
    if (t.isEmpty) continue;
    if (seen.add(t)) l2s.add(t);
    if (l2s.length >= 8) break;
  }

  if (l2s.isNotEmpty) {
    final shown = l2s.take(4).toList();
    final more = l2s.length > 4 ? ' · +${l2s.length - 4} more' : '';
    return '${shown.join(' · ')}$more';
  }

  // Fallback to existing behavior if we can't extract any L2 terms.
  final vocab = vocabBlocks;
  final target = vocab.isNotEmpty ? vocab.first : blocks.first;
  return _renderBlockPreview(target).trim();
}

      return sessions
          .map((s) => !_isPlaceholderPreview(s.preview)
              ? s
              : _LearningSessionSummary(
                  id: s.id,
                  createdAt: s.createdAt,
                  counts: s.counts,
                  preview: pickPreview(bySession[s.id] ?? const <_LearningBlock>[]),
                ))
          .toList();
    } catch (e) {
      debugPrint('⚠️ hydrate previews failed: $e');
      return sessions;
    }
  }


  List<_LearningSessionSummary> _parseSessionSummaries(dynamic data) {
    final list = (data is List) ? data : const [];
    final out = <_LearningSessionSummary>[];
    for (final row in list) {
      if (row is! Map) continue;
      final m = Map<String, dynamic>.from(row);

      final String id = (m['id'] ?? m['session_id'] ?? '').toString();
      if (id.isEmpty) continue;

      DateTime createdAt = DateTime.now();
      final ca = m['created_at'] ?? m['createdAt'];
      if (ca is String) {
        createdAt = DateTime.tryParse(ca) ?? createdAt;
      }

      Map<String, int> counts = {};
      final c = m['counts'] ?? m['counts_json'] ?? m['countsJson'];
      if (c is Map) {
        counts = c.map((k, v) => MapEntry(k.toString(), (v is num) ? v.toInt() : int.tryParse(v.toString()) ?? 0));
      } else if (c is String) {
        try {
          final decoded = jsonDecode(c);
          if (decoded is Map) {
            counts = decoded.map((k, v) => MapEntry(k.toString(), (v is num) ? v.toInt() : int.tryParse(v.toString()) ?? 0));
          }
        } catch (_) {}
      }

      out.add(_LearningSessionSummary(id: id, createdAt: createdAt, counts: counts));
    }
    // newest first
    out.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return out;
  }

Future<void> _runSearch() async {
    final q = _searchCtl.text.trim();
    if (q.isEmpty) {
      setState(() => _searchHits = const []);
      return;
    }
    setState(() => _loading = true);
    try {
      final data = await widget.client.rpc('search_learning_blocks', params: {
        'p_query': q,
        'p_tag': (_tagFilter == 'ALL') ? null : _tagFilter,
        'p_limit': 50,
        'p_offset': 0,
      });

      final list = (data is List) ? data : const [];
      final hits = list
          .whereType<Map>()
          .map((m) => Map<String, dynamic>.from(m))
          .toList(growable: false);

      if (mounted) setState(() => _searchHits = hits);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Search failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Widget _buildCurrent() {
    final blocks = widget.currentBlocks.isNotEmpty ? widget.currentBlocks : _currentBlocksDb;
    if (_loadingCurrent && blocks.isEmpty) {
      return const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()));
    }
    if (blocks.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text('No learning items for this session yet.\n\nTip: Ask for a vocab list or a short drill.'),
        ),
      );
    }

    // Mirror Review: show phrase-level cards (L2 + Show answer -> romanization/meaning/notes).
    final rawL2s = _collectL2FromBlocks(blocks);
    final seen = <String>{};
    final l2s = <String>[];
    for (final s in rawL2s) { final t = s.trim(); if (t.isEmpty) continue; if (seen.add(t)) l2s.add(t); }
    if (l2s.isNotEmpty) {
      return ListView.separated(
        padding: const EdgeInsets.all(12),
        itemCount: l2s.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final l2 = l2s[i].trim();
          final key = 'CUR|$l2';
          final cached = _phraseCacheByL2[l2] ?? const <String, String>{};

          final rom = (cached['romanization'] ?? '').trim();
          final meaning = (cached['meaning'] ?? '').trim();
          final notes = (cached['notes'] ?? '').trim();
          final needs = _needsEnrichmentL2.contains(l2) || (rom + meaning + notes).trim().isEmpty;

          String line(String label, String value) => '$label: ${value.trim().isNotEmpty ? value.trim() : '—'}';

          return Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Text(l2, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                      ),
                      if (needs)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: Colors.orange.withOpacity(0.12),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: const Text('Needs enrichment', style: TextStyle(fontSize: 12)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(line('Romanization', rom)),
                  const SizedBox(height: 4),
                  Text(line('Meaning', meaning)),
                  const SizedBox(height: 4),
                  Text(line('Explanation', notes)),
                ],
              ),
            ),
          );
        },
      );
    }

    // Fallback: show raw blocks (non-vocab learning blocks, if any).
    return ListView.separated(
      padding: const EdgeInsets.all(12),
      itemCount: blocks.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (context, i) {
        final b = blocks[i];
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('[${b.tag}]', style: const TextStyle(fontWeight: FontWeight.bold)),
                if (b.title != null && b.title!.trim().isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(b.title!.trim(), style: const TextStyle(fontSize: 16)),
                  ),
                if (b.content.trim().isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(b.content.trim()),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }



  // ------------------------------
  // Review status persistence (local, no schema changes)
  // ------------------------------

  String _reviewPrefsKey() {
    final scope = tl.isEmpty ? 'ALL' : tl;
    return 'review_status_${widget.userId}_$scope';
  }

  String _reviewKeyFor(_ReviewCard c) {
    final scope = tl.isEmpty ? 'ALL' : tl;
    final m = (c.meaning ?? '').trim();
    return '$scope|${c.l2}|$m';
  }

  int _cardStatus(_ReviewCard c) {
    final k = _reviewKeyFor(c);
    return (_reviewStatus[k] ?? 0).clamp(0, 2);
  }

  Future<void> _loadReviewStatus() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_reviewPrefsKey());
      if (raw == null || raw.trim().isEmpty) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      _reviewStatus
        ..clear()
        ..addAll(decoded.map((k, v) => MapEntry(k.toString(), (v is num) ? v.toInt() : int.tryParse(v.toString()) ?? 0)));
      if (mounted) setState(() {});
    } catch (_) {
      // ignore
    }
  }

  Future<void> _saveReviewStatus() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_reviewPrefsKey(), jsonEncode(_reviewStatus));
    } catch (_) {
      // ignore
    }
  }

  Future<void> _setCardStatus(_ReviewCard c, int status) async {
    final k = _reviewKeyFor(c);
    if (status <= 0) {
      _reviewStatus.remove(k);
    } else {
      _reviewStatus[k] = status.clamp(0, 2);
    }
    if (mounted) setState(() {});
    await _saveReviewStatus();
  }


  String _reviewSchedulePrefsKey() {
    final scope = tl.isEmpty ? 'ALL' : tl;
    return 'review_schedule_${widget.userId}_$scope';
  }

  Future<void> _loadReviewSchedule() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_reviewSchedulePrefsKey());
      if (raw == null || raw.trim().isEmpty) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      _reviewSchedule
        ..clear()
        ..addAll(decoded.map((k, v) {
          if (v is Map) {
            return MapEntry(k.toString(), v.map((kk, vv) => MapEntry(kk.toString(), vv)));
          }
          return MapEntry(k.toString(), <String, dynamic>{});
        }));
      if (mounted) setState(() {});
    } catch (_) {
      // ignore
    }
  }

  Future<void> _saveReviewSchedule() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_reviewSchedulePrefsKey(), jsonEncode(_reviewSchedule));
    } catch (_) {
      // ignore
    }
  }

  Map<String, dynamic> _schedFor(_ReviewCard c) {
    final k = _reviewKeyFor(c);
    return _reviewSchedule[k] ?? <String, dynamic>{};
  }

  int _dueMsFor(_ReviewCard c) {
    final s = _schedFor(c);
    final v = s['due_ms'];
    if (v is num) return v.toInt();
    return int.tryParse(v?.toString() ?? '') ?? 0;
  }

  bool _isDue(_ReviewCard c, int nowMs) {
    final st = _cardStatus(c);
    if (st == 0) return false; // New cards are handled by the NEW filter, not Due.
    final due = _dueMsFor(c);
    if (due <= 0) return true;
    return due <= nowMs;
  }

  Future<void> _markAgain(_ReviewCard c) async {
    final k = _reviewKeyFor(c);
    final now = DateTime.now().millisecondsSinceEpoch;
    final prev = _reviewSchedule[k] ?? <String, dynamic>{};
    final ease = (prev['ease'] is num) ? (prev['ease'] as num).toDouble() : 2.3;
    // short retry window
    const intervalMs = 10 * 60 * 1000; // 10 minutes
    _reviewStatus[k] = 1;
    _reviewSchedule[k] = <String, dynamic>{
      'due_ms': now + intervalMs,
      'interval_ms': intervalMs,
      'ease': ease,
    };
    if (mounted) setState(() {});
    await _saveReviewStatus();
    await _saveReviewSchedule();
  }

  Future<void> _markMastered(_ReviewCard c) async {
    final k = _reviewKeyFor(c);
    final now = DateTime.now().millisecondsSinceEpoch;
    final prev = _reviewSchedule[k] ?? <String, dynamic>{};
    final prevInterval = (prev['interval_ms'] is num) ? (prev['interval_ms'] as num).toInt() : 24 * 60 * 60 * 1000;
    final prevEase = (prev['ease'] is num) ? (prev['ease'] as num).toDouble() : 2.3;

    final nextEase = (prevEase + 0.05).clamp(1.3, 2.8);
    final nextInterval = (prevInterval * nextEase).round().clamp(24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
    _reviewStatus[k] = 2;
    _reviewSchedule[k] = <String, dynamic>{
      'due_ms': now + nextInterval,
      'interval_ms': nextInterval,
      'ease': nextEase,
    };
    if (mounted) setState(() {});
    await _saveReviewStatus();
    await _saveReviewSchedule();
  }

  Future<void> _loadReviewCards() async {
    setState(() => _loadingReview = true);
    try {
      // Phrase-level cache: fast, already enriched; no Gemini calls here.
      final q = widget.client
          .from('learning_phrase_cache')
          .select('l2, romanization, meaning, notes, updated_at, target_locale');
      final tl0 = (widget.targetLocale ?? '').trim();
      dynamic q2 = q;
      if (tl0.isNotEmpty) {
        q2 = q.eq('target_locale', tl0);
      }
      final rows = await q2.order('updated_at', ascending: false).limit(250);

      final list = (rows is List) ? rows : const [];
      final cards = <_ReviewCard>[];
      for (final r in list) {
        if (r is! Map) continue;
        final m = Map<String, dynamic>.from(r);
        final l2 = (m['l2'] ?? '').toString().trim();
        if (l2.isEmpty) continue;
        cards.add(_ReviewCard.fromJson(m));
        _phraseCacheByL2[l2] = {
          'romanization': (m['romanization'] ?? '').toString().trim(),
          'meaning': (m['meaning'] ?? '').toString().trim(),
          'notes': (m['notes'] ?? '').toString().trim(),
        };
      }

      if (!mounted) return;
      setState(() {
        _reviewCards = cards;
        _revealedReview.clear();
      });
    } catch (e) {
      debugPrint('⚠️ load review cards failed: $e');
    } finally {
      if (mounted) setState(() => _loadingReview = false);
    }
  }

  Widget _buildReview() {
    if (_loadingReview && _reviewCards.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final filtered = _reviewCards.where((c) {
      final st = _cardStatus(c);
      switch (_reviewFilter) {
        case 'NEW':
          return st == 0;
        case 'LEARNING':
          return st == 1;
        case 'MASTERED':
          return st == 2;
        case 'DUE':
          return _isDue(c, nowMs);
        case 'ALL':
        default:
          return true;
      }
    }).toList(growable: false);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      ChoiceChip(
                        label: const Text('New'),
                        selected: _reviewFilter == 'NEW',
                        onSelected: (_) => setState(() => _reviewFilter = 'NEW'),
                      ),
                      const SizedBox(width: 8),
                      ChoiceChip(
                        label: const Text('Learning'),
                        selected: _reviewFilter == 'LEARNING',
                        onSelected: (_) => setState(() => _reviewFilter = 'LEARNING'),
                      ),
                      const SizedBox(width: 8),
                      ChoiceChip(
                        label: const Text('Due'),
                        selected: _reviewFilter == 'DUE',
                        onSelected: (_) => setState(() => _reviewFilter = 'DUE'),
                      ),
                      const SizedBox(width: 8),
                      ChoiceChip(
                        label: const Text('Mastered'),
                        selected: _reviewFilter == 'MASTERED',
                        onSelected: (_) => setState(() => _reviewFilter = 'MASTERED'),
                      ),
                      const SizedBox(width: 8),
                      ChoiceChip(
                        label: const Text('All'),
                        selected: _reviewFilter == 'ALL',
                        onSelected: (_) => setState(() => _reviewFilter = 'ALL'),
                      ),
                    ],
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Refresh',
                onPressed: _loadReviewCards,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
        if (filtered.isEmpty)
          Expanded(
            child: Center(
              child: Text(
                _reviewCards.isEmpty
                    ? 'No cached phrases yet. Finish a learning session (or ask for vocab) and the app will build your deck automatically.'
                    : 'No cards in this filter yet.',
                textAlign: TextAlign.center,
              ),
            ),
          )
        else
          Expanded(
            child: ListView.builder(
              itemCount: filtered.length,
              itemBuilder: (context, i) {
                final c = filtered[i];
                final key = _reviewKeyFor(c);
                final revealed = _revealedReview.contains(key);
                final st = _cardStatus(c);

                final answerParts = <String>[];
                if ((c.romanization ?? '').trim().isNotEmpty) answerParts.add(c.romanization!.trim());
                if ((c.meaning ?? '').trim().isNotEmpty) answerParts.add(c.meaning!.trim());
                if ((c.notes ?? '').trim().isNotEmpty) answerParts.add(c.notes!.trim());
                final answer = answerParts.join('\n');

                Widget statusChip() {
                  if (st == 2) return const Chip(label: Text('Mastered'));
                  if (st == 1) return const Chip(label: Text('Learning'));
                  return const Chip(label: Text('New'));
                }

                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(c.l2, style: Theme.of(context).textTheme.titleLarge),
                            ),
                            if (widget.onSpeakL2 != null)
                              IconButton(
                                tooltip: 'Speak',
                                icon: const Icon(Icons.volume_up, size: 18),
                                onPressed: () => widget.onSpeakL2!(c.l2, tl),
                              ),
                            statusChip(),
                          ],
                        ),
                        const SizedBox(height: 8),
                        if (!revealed)
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              onPressed: () {
                                setState(() => _revealedReview.add(key));
                                // Do not change status on reveal; keep in NEW until user explicitly marks it.
                              },
                              child: const Text('Show answer'),
                            ),
                          )
                        else ...[
                          if (answer.isNotEmpty) Text(answer),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              TextButton.icon(
                                onPressed: () => _markAgain(c),
                                icon: const Icon(Icons.refresh),
                                label: const Text('Again'),
                              ),
                              const SizedBox(width: 8),
                              TextButton.icon(
                                onPressed: () => _markMastered(c),
                                icon: const Icon(Icons.check_circle_outline),
                                label: const Text('Mastered'),
                              ),
                              const Spacer(),
                              TextButton(
                                onPressed: () => setState(() => _revealedReview.remove(key)),
                                child: const Text('Hide'),
                              ),
                            ],
                          ),
                        ]
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
      ],
    );
  }

  Widget _buildHistory() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              TextField(
                controller: _searchCtl,
                decoration: InputDecoration(
                  labelText: 'Search learning history',
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.search),
                    onPressed: _runSearch,
                  ),
                ),
                onSubmitted: (_) => _runSearch(),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  const Text('Tag:'),
                  const SizedBox(width: 12),
                  DropdownButton<String>(
                    value: _tagFilter,
                    items: const [
                      DropdownMenuItem(value: 'ALL', child: Text('All')),
                      DropdownMenuItem(value: 'LESSON', child: Text('Lesson')),
                      DropdownMenuItem(value: 'VOCAB', child: Text('Vocab')),
                      DropdownMenuItem(value: 'DRILL', child: Text('Drill')),
                      DropdownMenuItem(value: 'QUIZ', child: Text('Quiz')),
                      DropdownMenuItem(value: 'NOTES', child: Text('Notes')),
                      DropdownMenuItem(value: 'ROM', child: Text('Rom')),
                    ],
                    onChanged: (v) {
                      if (v == null) return;
                      setState(() => _tagFilter = v);
                    },
                  ),
                  const Spacer(),
                  TextButton(
                    onPressed: _loadRecentSessions,
                    child: const Text('Refresh'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        if (_loading)
          const LinearProgressIndicator(),
        Expanded(
          child: _searchHits.isNotEmpty
              ? ListView.builder(
                  itemCount: _searchHits.length,
                  itemBuilder: (context, i) {
                    final h = _searchHits[i];
                    final tag = (h['tag'] ?? '').toString();
                    final title = (h['title'] ?? '').toString();
                    final content = (h['content'] ?? '').toString();
                    return ListTile(
                      title: Text('[$tag] ${title.isNotEmpty ? title : ''}'.trim()),
                      subtitle: Text(content, maxLines: 3, overflow: TextOverflow.ellipsis),
                    );
                  },
                )
              : ListView.builder(
                  itemCount: _sessions.length,
                  itemBuilder: (context, i) {
                    final s = _sessions[i];
                    final entries = s.counts.entries.where((e) => e.value > 0).toList()
                      ..sort((a, b) => b.value.compareTo(a.value));
                    final top = entries.take(3).map((e) => '${e.key} • ${e.value}').join(' · ');
                    final more = entries.length > 3 ? ' · +${entries.length - 3} more' : '';
                    final countsLine = top.isEmpty ? 'No blocks' : '$top$more';
                    final preview = s.preview.trim();

                    String _l2ForSpeak(String p) {
                      final s = p.trim();
                      if (s.isEmpty) return '';
                      final first = s.split('\n').first.trim();
                      if (first.contains('—')) return first.split('—').first.trim();
                      if (first.contains(' - ')) return first.split(' - ').first.trim();
                      return first;
                    }
                   
                    return ListTile(
                      title: Text(_formatShortDateTime(s.createdAt)),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (preview.isNotEmpty)
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(
                                  child: Text(preview, maxLines: 2, overflow: TextOverflow.ellipsis),
                                ),
                              ],
                            ),
                          Text(countsLine, maxLines: 1, overflow: TextOverflow.ellipsis),
                        ],
                      ),
                      onTap: () => _openSessionDetails(s),
                    );
                  },
                ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Learning Hub'),
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: 'This session'),
            Tab(text: 'History'),
            Tab(text: 'Review'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildCurrent(),
          _buildHistory(),
          _buildReview(),
        ],
      ),
    );
  }
}