part of chat_screen;

extension _ChatScreenTtsExt on _ChatScreenState {

  String _detectLangForSegment(String segment) {
    final s = segment.trim();
    final l1 = _preferredLocale;
    final hasL2 = (_targetLocale ?? '').trim().isNotEmpty;
    final l2 = hasL2 ? _targetLocale! : _preferredLocale;

    final lower = s.toLowerCase();

    if (lower.startsWith('[l2]') || lower.startsWith('l2:')) return l2;
    if (lower.startsWith('[l1]') || lower.startsWith('l1:')) return l1;

    final localeTag = RegExp(r'^\[([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\]').firstMatch(s);
    if (localeTag != null) {
      final tag = (localeTag.group(1) ?? '').trim();
      if (tag.toLowerCase() == l2.toLowerCase()) return l2;
      if (tag.toLowerCase() == l1.toLowerCase()) return l1;
    }
    return l1;
  }
  /// Removes pronunciation/romanization helper fragments in a language-agnostic way.
  /// Goal: keep normal parentheses, but drop short parenthetical/IPA-style hints that
  /// commonly cause TTS to spell things out.
  String _stripPronunciationHelper(String input) {
    var text = input;

    // Remove IPA wrapped in slashes, e.g. /fəˈnɛtɪk/
    text = text.replaceAll(RegExp(r'/[^/]{2,80}/'), '');

    // Remove short parenthetical hints that look like romanization/phonetics.
    // Heuristic: inside parens is mostly ASCII letters/digits/spaces/hyphen/apostrophe
    // or contains common IPA markers.
    final paren = RegExp(r'\(([^()]*)\)');
    text = text.replaceAllMapped(paren, (m) {
      final inside = (m.group(1) ?? '').trim();
      if (inside.isEmpty) return '';
      if (inside.length > 45) return m.group(0) ?? '';
      final looksIpa = RegExp(r'[ˈˌəɪʊɔæŋʃʒθðɾɹɲɳ]').hasMatch(inside);
      final looksRomanized = RegExp(r"^[A-Za-z0-9\s\-']+$").hasMatch(inside);
      // If it contains a lot of commas/semicolons, it's probably real aside text—keep it.
      final hasHeavyPunct = RegExp(r'[,;:]').hasMatch(inside);
      if (!hasHeavyPunct && (looksIpa || looksRomanized)) return '';
      return m.group(0) ?? '';
    });

    // Collapse extra whitespace
    text = text.replaceAll(RegExp(r'\s{2,}'), ' ').trim();
    return text;
  }


  bool _isTargetScriptCombiningMark(int codePoint) {
    // TargetScript combining marks range: U+0E30–U+0E3A and U+0E47–U+0E4E (roughly).
    return (codePoint >= 0x0E30 && codePoint <= 0x0E3A) ||
        (codePoint >= 0x0E47 && codePoint <= 0x0E4E);
  }

  String _cleanupTargetForTts(String input) {
    if (input.trim().isEmpty) return '';

    // 1) Keep only TargetScript chars, whitespace, and basic punctuation
    final filtered = input.replaceAll(
      RegExp(r'[^\uFFFF-\uFFFF\s\?\!\.,]'),
      '',
    );

    // 2) Tokenize by whitespace
    final tokens = filtered.split(RegExp(r'\s+'));

    // 3) Drop obviously broken or tiny tokens (like orphan "ื" or "ือ")
    final cleanedTokens = tokens.where((t) {
      final runes = t.runes.toList();
      if (runes.isEmpty) return false;
      // If the first code point is a combining mark, this is probably garbage
      if (_isTargetScriptCombiningMark(runes.first)) return false;
      // Too short → usually garbage
      if (runes.length < 2) return false;
      return true;
    }).toList();

    // 4) Rejoin and trim
    return cleanedTokens.join(' ').trim();
  }

  Future<void> _speakTextWithAutoLanguage(String text) async {
    if (text.trim().isEmpty) return;

    await _tts.awaitSpeakCompletion(true);

    final matches = _languageSegmentRegex.allMatches(text);

    for (final match in matches) {
      final rawSeg = match.group(0)?.trim() ?? '';
      if (rawSeg.isEmpty) continue;

      final langCode = _detectLangForSegment(rawSeg);

      var speakText = rawSeg
          .replaceAll(RegExp(r'\[L1\]|\[L2\]', caseSensitive: false), '')
          .replaceAll(RegExp(r'^\s*(L1|L2)\s*:\s*', caseSensitive: false), '')
          .trim();

      speakText = _stripPronunciationHelper(speakText);
      speakText = _cleanForTts(speakText);
      speakText = speakText.replaceFirst(RegExp(r'^[\s\.,;:!\?\-–—]+'), '').trim();
      if (speakText.isEmpty) continue;
      if (RegExp(r'^[\.,;:!\?\-–—]+$').hasMatch(speakText)) continue;

      await _tts.setLanguage(langCode);
      await _tts.speak(speakText);

      await Future.delayed(const Duration(milliseconds: 50));
    }
  }

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
    // code-ish punctuation), while preserving TargetScript script when present.
    var cleaned = text;

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

    // 5) Remove parenthetical pronunciation/romanization hints in a language-agnostic way.
    //    - If parentheses contain primarily Latin-like characters (e.g., "(sa-wat-dee)") → drop.
    //    - If parentheses contain any non-Latin-like letters (e.g., native script) → keep.
    cleaned = cleaned.replaceAllMapped(
      RegExp(r'\(([^)]{1,80})\)'),
      (m) {
        final inner = (m.group(1) ?? '').trim();
        if (inner.isEmpty) return '';
        // Keep parentheses that contain any non-Latin-like letters (likely native script).
        if (_containsNonLatinLikeLetter(inner)) return '($inner)';
        // Otherwise, drop short Latin/IPA-ish helper fragments.
        final hasLatinLetter = RegExp(r'[A-Za-z]').hasMatch(inner);
        final hasIpaish = RegExp(r'[ːˈˌɑɔəɛɪʊʌŋθðʃʒɲ]').hasMatch(inner);
        if (hasLatinLetter || hasIpaish) return '';
        return '';
      },
    );

    // 6) Replace remaining slashes / backslashes with a space.
    cleaned = cleaned.replaceAll(RegExp(r'[\\/]+'), ' ');

    // 7) Remove punctuation that some engines speak out loud ("dot", "comma", etc.).
    //    We keep apostrophes for preferred-locale contractions.
    cleaned = cleaned
        .replaceAll(RegExp(r'[.!?…]+'), ' ')
        .replaceAll(RegExp(r'[:;]+'), ' ')
        .replaceAll(RegExp(r'[,]+'), ' ')
        // Escape [] inside the char class.
        .replaceAll(RegExp(r'[#@<>\[\]{}|^]+'), ' ')
        .replaceAll(RegExp(r'[_=*]+'), ' ');

    // 8) Collapse whitespace.
    cleaned = cleaned.replaceAll(RegExp(r'\s{2,}'), ' ');

    return cleaned.trim();
  }

  // --- Script heuristics (language-agnostic) ---
  bool _isAsciiLetter(int rune) => (rune >= 0x41 && rune <= 0x5A) || (rune >= 0x61 && rune <= 0x7A);

  // Treat Latin + Latin-extended letters as "Latin-like" so we don't destroy accents (á, ü, ñ, etc.).
  bool _isLatinLikeLetter(int rune) {
    if (_isAsciiLetter(rune)) return true;
    // Latin-1 Supplement + Latin Extended-A/B (covers most Western/central European letters).
    if (rune >= 0x00C0 && rune <= 0x024F) return true;
    // Combining diacritics (keep attached to Latin letters).
    if (rune >= 0x0300 && rune <= 0x036F) return true;
    return false;
  }

  bool _isWhitespaceDigitOrBasicPunct(int rune) {
    final ch = String.fromCharCode(rune);
    if (RegExp(r'\s').hasMatch(ch)) return true;
    if (rune >= 0x30 && rune <= 0x39) return true; // 0-9
    // Basic ASCII punctuation/symbols (safe to keep with either script).
    if (RegExp(r'''[!"#\$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~]''').hasMatch(ch)) return true;
    return false;
  }

  bool _isNonLatinLikeLetter(int rune) {
    if (_isLatinLikeLetter(rune)) return false;
    if (_isWhitespaceDigitOrBasicPunct(rune)) return false;
    // Heuristic: any other letter-like codepoint is treated as non-Latin-like.
    return rune > 0x024F;
  }

  bool _containsNonLatinLikeLetter(String s) => s.runes.any(_isNonLatinLikeLetter);

  /// In L1 output, drop non-Latin-like letters when the text mixes scripts.
  /// This prevents the L1 voice from trying to pronounce target-script fragments.
  String _stripTargetScriptFromL1(String text) {
    if (text.isEmpty) return text;
    if ((_targetLocale ?? '').trim().isEmpty) return text;
    if ((_preferredLocale).toLowerCase() == (_targetLocale ?? '').toLowerCase()) return text;

    bool hasLatinLike = false;
    bool hasNonLatinLike = false;
    for (final r in text.runes) {
      if (_isLatinLikeLetter(r)) hasLatinLike = true;
      if (_isNonLatinLikeLetter(r)) hasNonLatinLike = true;
      if (hasLatinLike && hasNonLatinLike) break;
    }
    if (!(hasLatinLike && hasNonLatinLike)) return text;

    final buf = StringBuffer();
    for (final r in text.runes) {
      if (_isNonLatinLikeLetter(r)) continue;
      buf.writeCharCode(r);
    }
    return buf.toString().replaceAll(RegExp(r'\s{2,}'), ' ').trim();
  }

  /// Splits mixed-script text into L1 (Latin-like) and L2 (non-Latin-like) buckets.
  /// This is a fallback for untagged model output. Prefer explicit [L1]/[L2] or [xx-XX] tags.
  Map<String, String> _splitL1AndTargetScript(String text) {
    if (text.isEmpty) return {'l1': '', 'l2': ''};
    if ((_targetLocale ?? '').trim().isEmpty) return {'l1': text.trim(), 'l2': ''};

    final l1Buf = StringBuffer();
    final l2Buf = StringBuffer();

    for (final rune in text.runes) {
      if (_isNonLatinLikeLetter(rune)) {
        l2Buf.writeCharCode(rune);
      } else {
        l1Buf.writeCharCode(rune);
      }
    }

    final l1Text = l1Buf.toString().replaceAll(RegExp(r'\s{2,}'), ' ').trim();
    final l2Text = l2Buf.toString().replaceAll(RegExp(r'\s{2,}'), ' ').trim();
    return {'l1': l1Text, 'l2': l2Text};
  }

  String _stripTrailingToneMarker(String text) {
  // Look for a trailing " ( ... )" at the END of the string.
  final trailingParenRegex = RegExp(r'\s*\(([^)]*)\)\s*$');
  final match = trailingParenRegex.firstMatch(text);
  if (match == null) {
    return text;
  }
  final inside = match.group(1) ?? '';
  final hasTargetScript = RegExp(r'[\uFFFF-\uFFFF]').hasMatch(inside);
  if (hasTargetScript) {
    return text;
  }
  // Otherwise, strip the entire parenthetical chunk at the end.
  final cleaned = text.replaceRange(match.start, text.length, '').trimRight();
  return cleaned;
  }

  String _stripJsonLikeTrailingJunk(String text) {
  var out = text.trimRight();

  // Remove trailing ", "" or ", or stray ] at the end of the string.
  // Example:  สวัสดีครับ (-- á)", ""
  out = out.replaceAll(RegExp(r'["\],]+$'), '').trimRight();

  return out;
  }

  bool _shouldSkipTargetScriptHelperSegment(String text) {
  final trimmed = text.trimLeft();

  // If it doesn't even start with a parenthesis, it's probably a real phrase.
  if (!trimmed.startsWith('(')) return false;

  final targetScriptRegex = RegExp(r'[\uFFFF-\uFFFF]');
  final letterRegex = RegExp(r'[A-Za-z\uFFFF-\uFFFF]');

  final targetScriptCount = targetScriptRegex.allMatches(text).length;
  final letterCount = letterRegex.allMatches(text).length;

  if (letterCount == 0) return false;

  final ratio = targetScriptCount / letterCount;

  // If fewer than ~50% of the characters are TargetScript, treat it as a helper blob.
  return ratio < 0.5;
  }

  Future<void> _playTtsForMessage(_ChatMessage msg) async {
    if (_voiceMode == 'silent') return;

    final raw = msg.text.trim();
    if (raw.isEmpty) return;

    final sanitizedRaw = _cleanForTts(raw);
    if (sanitizedRaw.isEmpty) return;

    final List<Map<String, String>> segments = [];
    final segmentRegex = RegExp(r'\[([^\]]+)\]\s*([^[]*)');
    final matches = segmentRegex.allMatches(sanitizedRaw);

    if (matches.isEmpty) {
      await _speakTextWithAutoLanguage(sanitizedRaw);
      return;
    }

    final hasL2 = (_targetLocale ?? '').trim().isNotEmpty;
    final l2 = hasL2 ? _targetLocale! : _preferredLocale;

    for (final m in matches) {
      final tag = (m.group(1) ?? '').trim();
      var textPart = (m.group(2) ?? '').trim();

      textPart = textPart
          .replaceAll(RegExp(r'^\s*(L1|L2)\s*:\s*', caseSensitive: false), '')
          .trim();

      textPart = _stripPronunciationHelper(textPart);
      textPart = _cleanForTts(textPart);
      if (textPart.isEmpty) continue;

      final upper = tag.toUpperCase();
      String lang;

      if (upper == 'L2') {
        lang = l2;
      } else if (upper == 'L1') {
        lang = _preferredLocale;
      } else {
        if (tag.toLowerCase() == l2.toLowerCase()) {
          lang = l2;
        } else if (tag.toLowerCase() == _preferredLocale.toLowerCase()) {
          lang = _preferredLocale;
        } else {
          lang = _preferredLocale;
        }
      }

      segments.add({'lang': lang, 'text': textPart});
    }

    if (segments.isEmpty) {
      await _speakTextWithAutoLanguage(sanitizedRaw);
      return;
    }

    await _tts.awaitSpeakCompletion(true);

    for (final seg in segments) {
      final lang = seg['lang'] ?? _preferredLocale;
      final t = seg['text'] ?? '';
      if (t.trim().isEmpty) continue;

      await _tts.setLanguage(lang);
      await _tts.speak(t);

      await Future.delayed(const Duration(milliseconds: 50));
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
}