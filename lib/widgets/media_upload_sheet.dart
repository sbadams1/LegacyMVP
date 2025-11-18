// lib/widgets/media_upload_sheet.dart

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import 'package:legacy_mobile/media_bridge.dart';

class MediaUploadSheet extends StatefulWidget {
  const MediaUploadSheet({
    super.key,
    this.onMediaUploaded,
  });

  /// Now also passes the local file path so caller can do STT, etc.
  final void Function(String url, String mediaType, String? localPath)?
      onMediaUploaded;

  @override
  State<MediaUploadSheet> createState() => _MediaUploadSheetState();
}

class _MediaUploadSheetState extends State<MediaUploadSheet> {
  final ImagePicker _picker = ImagePicker();

  bool _busy = false;
  String? _lastUrl;
  String? _error;

  Future<void> _pickAndUpload(String mediaType) async {
    if (_busy) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      XFile? picked;
      if (mediaType == 'image') {
        picked = await _picker.pickImage(source: ImageSource.gallery);
      } else {
        picked = await _picker.pickVideo(source: ImageSource.gallery);
      }

      if (picked == null) {
        setState(() => _busy = false);
        return;
      }

      final url = await uploadMediaFile(
        file: File(picked.path),
        mediaType: mediaType,
      );

      setState(() => _lastUrl = url);

      widget.onMediaUploaded?.call(url, mediaType, picked.path);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('${mediaType.toUpperCase()} saved to Supabase'),
          ),
        );
      }
    } catch (e) {
      setState(() => _error = 'Error: $e');
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding:
            const EdgeInsets.symmetric(horizontal: 16.0, vertical: 16.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Attach Photos & Videos',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 12),
            if (_error != null)
              Text(
                _error!,
                style: const TextStyle(color: Colors.red),
              ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                ElevatedButton.icon(
                  onPressed: _busy ? null : () => _pickAndUpload('image'),
                  icon: const Icon(Icons.photo),
                  label: const Text('Upload Photo'),
                ),
                const SizedBox(width: 12),
                ElevatedButton.icon(
                  onPressed: _busy ? null : () => _pickAndUpload('video'),
                  icon: const Icon(Icons.videocam),
                  label: const Text('Upload Video'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (_busy) const Text('Uploading...'),
            if (_lastUrl != null)
              Text(
                'Last upload:\n$_lastUrl',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
          ],
        ),
      ),
    );
  }
}
