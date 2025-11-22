// lib/services/donor_profile_service.dart
//
// Small service to read the current user's profile from Supabase.
//
// It uses the `profiles` table with columns:
//   id                   uuid (PK, same as auth user id)
//   preferred_language   text
//   supported_languages  text[] (ARRAY)
//   voice_avatar_consent boolean
//   share_with_family    boolean
//   tos_accepted         boolean
//   tos_accepted_at      timestamptz
//
// This service is primarily used by AIBrainService to resolve the
// user's primaryLanguage (for passing into ai-brain and memory-summarize).

import 'package:supabase_flutter/supabase_flutter.dart';

class DonorProfile {
  final String id;
  final String primaryLanguage;
  final List<String> secondaryLanguages;
  final bool voiceAvatarConsent;
  final bool shareWithFamily;
  final bool tosAccepted;
  final DateTime? tosAcceptedAt;

  DonorProfile({
    required this.id,
    required this.primaryLanguage,
    required this.secondaryLanguages,
    required this.voiceAvatarConsent,
    required this.shareWithFamily,
    required this.tosAccepted,
    required this.tosAcceptedAt,
  });

  factory DonorProfile.fromMap(Map<String, dynamic> map) {
    final secondaryRaw = map['supported_languages'];
    final secondaries = <String>[];
    if (secondaryRaw is List) {
      secondaries.addAll(secondaryRaw.whereType<String>());
    }

    DateTime? tosTime;
    final ts = map['tos_accepted_at'];
    if (ts is String && ts.isNotEmpty) {
      tosTime = DateTime.tryParse(ts);
    }

    return DonorProfile(
      id: (map['id'] ?? '').toString(),
      // Fall back to 'en' if preferred_language is null/empty.
      primaryLanguage: (map['preferred_language'] as String?)?.trim().isNotEmpty == true
          ? (map['preferred_language'] as String)
          : 'en',
      secondaryLanguages: secondaries,
      voiceAvatarConsent: map['voice_avatar_consent'] as bool? ?? true,
      shareWithFamily: map['share_with_family'] as bool? ?? true,
      tosAccepted: map['tos_accepted'] as bool? ?? false,
      tosAcceptedAt: tosTime,
    );
  }
}

class DonorProfileService {
  DonorProfileService._();
  static final DonorProfileService instance = DonorProfileService._();

  final SupabaseClient _client = Supabase.instance.client;

  /// Returns the current user's profile from the `profiles` table,
  /// or null if no row exists yet.
  Future<DonorProfile?> getCurrentUserProfile() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      return null;
    }

    final data = await _client
        .from('profiles')
        .select()
        .eq('id', user.id)
        .maybeSingle();

    if (data == null) return null;

    return DonorProfile.fromMap(data);
  }
}
