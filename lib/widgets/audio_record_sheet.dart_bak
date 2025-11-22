// lib/widgets/audio_record_sheet.dart

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_sound/flutter_sound.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

import 'package:legacy_mobile/services/ai_bridge.dart'; // for callGoogleSpeech

class AudioRecordSheet extends StatefulWidget {
  const AudioRecordSheet({
    super.key,
    required this.onTranscriptionComplete,
  });

  final void Function(String transcript) onTranscriptionComplete;

  @override
  State<AudioRecordSheet> createState() => _AudioRecordSheetState();
}

class _AudioRecordSheetState extends State<AudioRecordSheet> {
  final FlutterSoundRecorder _recorder = FlutterSoundRecorder();
  final FlutterSoundPlayer _player = FlutterSoundPlayer();

  bool _recorderReady = false;
  bool _playerReady = false;

  bool _isRecording = false;
  bool _isPlaying = false;
  bool _busy = false;

  String? _audioPath;
  String? _error;
  String? _transcription;

  @override
  void initState() {
    super.initState();
    _initAudio();
  }

  Future<void> _initAudio() async {
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final micStatus = await Permission.microphone.request();
      if (!micStatus.isGranted) {
        setState(() {
          _error = 'Microphone permission is required to record audio.';
        });
        return;
      }

      await _recorder.openRecorder();
      await _player.openPlayer();

      setState(() {
        _recorderReady = true;
        _playerReady = true;
      });
    } catch (e) {
      setState(() {
        _error = 'Failed to initialize audio: $e';
      });
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _recorder.closeRecorder();
    _player.closePlayer();
    super.dispose();
  }

  Future<void> _startRecording() async {
    if (!_recorderReady || _busy) return;

    setState(() {
      _error = null;
    });

    try {
      final dir = await getTemporaryDirectory();
      _audioPath =
          '${dir.path}/recording_${DateTime.now().millisecondsSinceEpoch}.aac';

      await _recorder.startRecorder(
        toFile: _audioPath,
        codec: Codec.aacADTS, // 👈 your known-good codec
      );

      setState(() => _isRecording = true);
    } catch (e) {
      setState(() {
        _error = 'Failed to start recording: $e';
        _isRecording = false;
      });
    }
  }

  Future<void> _stopRecording() async {
    if (!_recorderReady || !_isRecording) return;

    try {
      await _recorder.stopRecorder();
      setState(() => _isRecording = false);
    } catch (e) {
      setState(() {
        _error = 'Failed to stop recording: $e';
      });
    }
  }

  Future<void> _toggleRecord() async {
    if (_isRecording) {
      await _stopRecording();
    } else {
      await _startRecording();
    }
  }

  Future<void> _startPlayback() async {
    if (!_playerReady || _audioPath == null || _busy) return;

    setState(() {
      _error = null;
    });

    try {
      await _player.startPlayer(
        fromURI: _audioPath,
        codec: Codec.aacADTS, // 👈 play back with same codec
        whenFinished: () {
          if (mounted) {
            setState(() => _isPlaying = false);
          }
        },
      );
      setState(() => _isPlaying = true);
    } catch (e) {
      setState(() {
        _error = 'Failed to play audio: $e';
        _isPlaying = false;
      });
    }
  }

  Future<void> _stopPlayback() async {
    if (!_playerReady || !_isPlaying) return;

    try {
      await _player.stopPlayer();
      setState(() => _isPlaying = false);
    } catch (e) {
      setState(() {
        _error = 'Failed to stop playback: $e';
      });
    }
  }

  Future<void> _togglePlay() async {
    if (_isPlaying) {
      await _stopPlayback();
    } else {
      await _startPlayback();
    }
  }

  Future<void> _sendForTranscription() async {
    if (_audioPath == null || _busy) return;

    setState(() {
      _busy = true;
      _error = null;
      _transcription = null;
    });

    try {
      final file = File(_audioPath!);
      if (!await file.exists()) {
        setState(() {
          _error = 'Recording file not found. Please record again.';
        });
        return;
      }

      final bytes = await file.readAsBytes();
      final base64Audio = base64Encode(bytes);

      // Let your backend handle encoding=MP3 / sampleRateHertz=48000.
      // We just send base64 audio (AAC container) like before.
      final transcript = await callGoogleSpeech(
        audioBase64: base64Audio,
        languageCode: 'en-US', // adjust if you later want Thai, etc.
      );

      if (transcript.trim().isEmpty) {
        setState(() {
          _error =
              'I couldn\'t understand that recording. Try speaking a bit louder or slightly shorter.';
        });
        return;
      }

      setState(() {
        _transcription = transcript;
      });

      // Hand the transcript back to ChatScreen
      widget.onTranscriptionComplete(transcript);

      if (mounted) {
        Navigator.of(context).pop();
      }
    } catch (e) {
      setState(() {
        _error = 'Speech-to-text error: $e';
      });
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final canSend = _audioPath != null && !_isRecording && !_busy;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Record a voice note',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 12),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Colors.red),
                  textAlign: TextAlign.center,
                ),
              ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                ElevatedButton.icon(
                  onPressed: _busy ? null : _toggleRecord,
                  icon: Icon(_isRecording ? Icons.stop : Icons.mic),
                  label: Text(_isRecording ? 'Stop' : 'Record'),
                ),
                const SizedBox(width: 12),
                ElevatedButton.icon(
                  onPressed: _busy || _audioPath == null ? null : _togglePlay,
                  icon: Icon(_isPlaying ? Icons.stop : Icons.play_arrow),
                  label: Text(_isPlaying ? 'Stop' : 'Play'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: canSend ? _sendForTranscription : null,
              child: _busy
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Send to transcription'),
            ),
            const SizedBox(height: 12),
            if (_transcription != null)
              Text(
                _transcription!,
                textAlign: TextAlign.center,
              ),
          ],
        ),
      ),
    );
  }
}
