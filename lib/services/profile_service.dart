// lib/services/profile_service.dart

import 'package:supabase_flutter/supabase_flutter.dart';

class Profile {
  final String id;
  final String? legalName;
  final String? displayName;
  final DateTime? birthdate;
  final String? countryRegion;
  final String? preferredLanguage;
  final bool tosAccepted;
  final DateTime? tosAcceptedAt;

  Profile({
    required this.id,
    this.legalName,
    this.displayName,
    this.birthdate,
    this.countryRegion,
    this.preferredLanguage,
    this.tosAccepted = false,
    this.tosAcceptedAt,
  });

  Profile copyWith({
    String? legalName,
    String? displayName,
    DateTime? birthdate,
    String? countryRegion,
    String? preferredLanguage,
    bool? tosAccepted,
    DateTime? tosAcceptedAt,
  }) {
    return Profile(
      id: id,
      legalName: legalName ?? this.legalName,
      displayName: displayName ?? this.displayName,
      birthdate: birthdate ?? this.birthdate,
      countryRegion: countryRegion ?? this.countryRegion,
      preferredLanguage: preferredLanguage ?? this.preferredLanguage,
      tosAccepted: tosAccepted ?? this.tosAccepted,
      tosAcceptedAt: tosAcceptedAt ?? this.tosAcceptedAt,
    );
  }

  static Profile fromMap(Map<String, dynamic> map) {
    return Profile(
      id: map['id'] as String,
      legalName: map['legal_name'] as String?,
      displayName: map['display_name'] as String?,
      birthdate: map['birthdate'] != null
          ? DateTime.tryParse(map['birthdate'].toString())
          : null,
      countryRegion: map['country_region'] as String?,
      preferredLanguage: map['preferred_language'] as String?,
      tosAccepted: (map['tos_accepted'] as bool?) ?? false,
      tosAcceptedAt: map['tos_accepted_at'] != null
          ? DateTime.tryParse(map['tos_accepted_at'].toString())
          : null,
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'legal_name': legalName,
      'display_name': displayName,
      'birthdate': birthdate?.toIso8601String(),
      'country_region': countryRegion,
      'preferred_language': preferredLanguage,
      'tos_accepted': tosAccepted,
      'tos_accepted_at': tosAcceptedAt?.toIso8601String(),
    };
  }
}

class ProfileService {
  final SupabaseClient _client = Supabase.instance.client;

  Future<Profile?> loadCurrentProfile() async {
    final user = _client.auth.currentUser;
    if (user == null) return null;

    final response = await _client
        .from('profiles')
        .select()
        .eq('id', user.id)
        .maybeSingle();

    if (response == null) {
      return Profile(id: user.id);
    }

    return Profile.fromMap(response as Map<String, dynamic>);
  }

  Future<void> upsertProfile(Profile profile) async {
    await _client.from('profiles').upsert(profile.toMap());
  }

  Future<void> acceptTosForCurrentUser() async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    final now = DateTime.now().toUtc();
    await _client.from('profiles').upsert({
      'id': user.id,
      'tos_accepted': true,
      'tos_accepted_at': now.toIso8601String(),
    });
  }

  Future<void> updateBasicsForCurrentUser({
    required String legalName,
    required String displayName,
    required DateTime birthdate,
    required String countryRegion,
    required String preferredLanguage,
  }) async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    await _client.from('profiles').upsert({
      'id': user.id,
      'legal_name': legalName,
      'display_name': displayName,
      'birthdate': birthdate.toIso8601String(),
      'country_region': countryRegion,
      'preferred_language': preferredLanguage,
    });
  }
}
