// lib/media_bridge.dart

import 'dart:io';
import 'package:supabase_flutter/supabase_flutter.dart';

final SupabaseClient _supabase = Supabase.instance.client;

/// Your existing buckets:
/// - 'photos' for images
/// - 'video' for videos
const String photosBucket = 'photos';
const String videoBucket = 'video';

String _bucketForMediaType(String mediaType) {
  switch (mediaType) {
    case 'image':
      return photosBucket;
    case 'video':
      return videoBucket;
    default:
      // Fallback: you can change this if you add more media types later.
      return photosBucket;
  }
}

/// Uploads a media file (image or video) to the correct Supabase Storage bucket
/// and returns the public URL. We no longer touch the brain_messages table here;
/// the Cloud Function "brain" owns that table.
Future<String> uploadMediaFile({
  required File file,
  required String mediaType, // 'image' or 'video'
}) async {
  final ext = file.path.split('.').last;
  // Optional: still include user id in the path for organization
  final userId = _supabase.auth.currentUser?.id ?? 'anon';

  final path =
      '$mediaType/$userId/${DateTime.now().millisecondsSinceEpoch}.$ext';

  final bucket = _bucketForMediaType(mediaType);

  // 1) Upload to Storage
  await _supabase.storage.from(bucket).upload(path, file);

  // 2) Get public URL
  final publicUrl = _supabase.storage.from(bucket).getPublicUrl(path);

  // 3) Return the URL to the caller (ChatScreen, etc.)
  return publicUrl;
}
