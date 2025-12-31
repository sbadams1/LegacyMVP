part of 'chat_screen.dart';

extension _ChatScreenModeExt on _ChatScreenState {

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

    final normalizedDevice = _normalizeLocale(deviceTag, fallback: 'en-US');

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

  Future<void> _sendMetaCommand(String command) async {
    // Reuse the normal send pipeline, but we can keep this as a separate
    // helper in case we ever want to treat meta-commands differently.
    await _sendTextMessage(command, showUserBubble: true);
  }

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
}
