part of chat_screen;

extension _ChatScreenAudioExt on _ChatScreenState {

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

  void _removeSttTempBubbleIfAny() {
    if (!mounted) return;
    setState(() {
      _messages.removeWhere(
        (m) => m.isUser == true && m.text.startsWith('[🎙️'),
      );
    });
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
      // In legacy/avatar/etc, we listen exclusively in L1 to avoid “cross-language” mis-detection.
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
}
