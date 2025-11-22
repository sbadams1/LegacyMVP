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

  bool _isRecorderInitialized = false;
  bool _isRecording = false;
  bool _isPlaying = false;
  String? _audioPath;
  String? _transcription;
  String? _error;

  @override
  void initState() {
    super.initState();
    _initRecorder();
    _initPlayer();
  }

  Future<void> _initRecorder() async {
    await _recorder.openRecorder();
    _isRecorderInitialized = true;
  }

  Future<void> _initPlayer() async {
    await _player.openPlayer();
  }

  @override
  void dispose() {
    _recorder.closeRecorder();
    _player.closePlayer();
    super.dispose();
  }

  Future<void> _startRecording() async {
    if (!_isRecorderInitialized) return;

    final status = await Permission.microphone.request();
    if (!status.isGranted) {
      setState(() {
        _error = 'Microphone permission is required to record.';
      });
      return;
    }

    final tempDir = await getTemporaryDirectory();
    final filepath = '${tempDir.path}/legacy_sheet_recording.aac';

    await _recorder.startRecorder(
      toFile: filepath,
      codec: Codec.aacADTS,
      numChannels: 1,
      sampleRate: 48000,
    );

    setState(() {
      _isRecording = true;
      _audioPath = filepath;
      _transcription = null;
      _error = null;
    });
  }

  Future<void> _stopRecording() async {
    if (!_isRecorderInitialized || !_isRecording) return;
    await _recorder.stopRecorder();
    setState(() {
      _isRecording = false;
    });
  }

  Future<void> _playRecording() async {
    if (_audioPath == null) {
      setState(() {
        _error = 'No recording available to play.';
      });
      return;
    }

    if (_isPlaying) {
      await _player.stopPlayer();
      setState(() {
        _isPlaying = false;
      });
      return;
    }

    await _player.startPlayer(
      fromURI: _audioPath,
      codec: Codec.aacADTS,
      whenFinished: () {
        if (!mounted) return;
        setState(() {
          _isPlaying = false;
        });
      },
    );

    setState(() {
      _isPlaying = true;
      _error = null;
    });
  }

  Future<void> _transcribeRecording() async {
    if (_audioPath == null) {
      setState(() {
        _error = 'No recording available to transcribe.';
      });
      return;
    }

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
        primaryLanguage: 'en-US', // adjust if you later want Thai, etc.
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
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 3),
            content: Text('Transcription complete and sent to chat.'),
          ),
        );
      }
    } catch (e) {
      setState(() {
        _error = 'Error during transcription: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding:
            EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 12),
            const Text(
              'Record a message',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton(
                  icon: Icon(
                    _isRecording ? Icons.stop : Icons.mic,
                    color: _isRecording ? Colors.red : Colors.blue,
                  ),
                  onPressed: _isRecording ? _stopRecording : _startRecording,
                ),
                const SizedBox(width: 16),
                IconButton(
                  icon: Icon(
                    _isPlaying ? Icons.stop : Icons.play_arrow,
                    color: Colors.green,
                  ),
                  onPressed: _playRecording,
                ),
                const SizedBox(width: 16),
                IconButton(
                  icon: const Icon(Icons.text_fields),
                  onPressed: _transcribeRecording,
                ),
              ],
            ),
            if (_transcription != null) ...[
              const Divider(),
              const Padding(
                padding: EdgeInsets.only(top: 8.0),
                child: Text(
                  'Transcription',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(8.0),
                child: Text(_transcription!),
              ),
            ],
            if (_error != null) ...[
              const Divider(),
              Padding(
                padding: const EdgeInsets.all(8.0),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Colors.red),
                ),
              ),
            ],
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}
