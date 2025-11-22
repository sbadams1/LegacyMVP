// lib/screens/settings_screen.dart
//
// Settings screen for the Legacy app
// - Primary language: dropdown from curated list
// - Secondary languages:
//     • Only shows languages the user has explicitly chosen
//     • Add via "Add secondary language" dropdown (curated list only)
//     • "Clear all secondary languages" removes all current selections
// - All values are stored locally in SharedPreferences AND synced to Supabase:
//
//   Supabase `profiles` table columns used here:
//     id                   uuid (PK, same as auth user id)
//     preferred_language   text
//     supported_languages  ARRAY (treated as text[])
//     voice_avatar_consent boolean
//     share_with_family    boolean
//     tos_accepted         boolean
//     tos_accepted_at      timestamptz
//
// If any of those column names change, update _loadFromSupabase()
// and _saveToSupabase() accordingly.

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _isLoading = true;

  // Supabase client
  final SupabaseClient _client = Supabase.instance.client;

  // In-memory state
  String? _primaryLanguageCode = 'en';
  final Set<String> _secondaryLanguageCodes = <String>{};

  bool _allowAvatarUsage = true;
  bool _allowFamilyAccess = true;
  bool _tosAccepted = false;
  DateTime? _tosAcceptedAt; // local-only timestamp

  // For "Add secondary language" dropdown
  String? _secondaryToAdd;

  // SharedPreferences keys (local-only)
  static const _kPrimaryLangKey = 'settings_primary_language';
  static const _kSecondaryLangsKey = 'settings_secondary_languages';
  static const _kAllowAvatarKey = 'settings_allow_avatar_usage';
  static const _kAllowFamilyKey = 'settings_allow_family_access';
  static const _kTosAcceptedKey = 'settings_tos_accepted';
  static const _kTosAcceptedAtKey = 'settings_tos_accepted_at';

  // Curated list of supported languages
  static const List<Map<String, String>> _languages = [
    {'code': 'en', 'label': 'English'},
    {'code': 'th', 'label': 'ไทย (Thai)'},
    {'code': 'es', 'label': 'Español'},
    {'code': 'fr', 'label': 'Français'},
    {'code': 'de', 'label': 'Deutsch'},
    {'code': 'it', 'label': 'Italiano'},
    {'code': 'pt', 'label': 'Português'},
    {'code': 'pt-BR', 'label': 'Português (Brasil)'},
    {'code': 'ja', 'label': '日本語 (Japanese)'},
    {'code': 'ko', 'label': '한국어 (Korean)'},
    {'code': 'zh', 'label': '中文 (Chinese)'},
    {'code': 'ru', 'label': 'Русский (Russian)'},
    {'code': 'hi', 'label': 'हिन्दी (Hindi)'},
    {'code': 'ar', 'label': 'العربية (Arabic)'},
  ];

  // Stub mapping language → example Google TTS voice id (not yet used)
  static const Map<String, String> _languageVoices = {
    'en': 'en-US-Neural2-A',
    'th': 'th-TH-Neural2-A',
    'es': 'es-ES-Neural2-A',
    'fr': 'fr-FR-Neural2-A',
    'de': 'de-DE-Neural2-A',
    'it': 'it-IT-Neural2-A',
    'pt': 'pt-PT-Neural2-A',
    'pt-BR': 'pt-BR-Neural2-A',
    'ja': 'ja-JP-Neural2-A',
    'ko': 'ko-KR-Neural2-A',
    'zh': 'cmn-CN-Neural2-A',
    'ru': 'ru-RU-Neural2-A',
    'hi': 'hi-IN-Neural2-A',
    'ar': 'ar-XA-Neural2-A',
  };

  @override
  void initState() {
    super.initState();
    _loadFromPrefs();
  }

  // ---------------------------------------------------------------------------
  // SharedPreferences: load & save
  // ---------------------------------------------------------------------------

  Future<void> _loadFromPrefs() async {
    final prefs = await SharedPreferences.getInstance();

    final primary = prefs.getString(_kPrimaryLangKey);
    final secondaryList = prefs.getStringList(_kSecondaryLangsKey);
    final allowAvatar = prefs.getBool(_kAllowAvatarKey);
    final allowFamily = prefs.getBool(_kAllowFamilyKey);
    final tosAccepted = prefs.getBool(_kTosAcceptedKey);
    final tosAcceptedAtStr = prefs.getString(_kTosAcceptedAtKey);

    setState(() {
      _primaryLanguageCode = primary ?? 'en';

      _secondaryLanguageCodes.clear();
      if (secondaryList != null && secondaryList.isNotEmpty) {
        _secondaryLanguageCodes.addAll(secondaryList);
      }

      _allowAvatarUsage = allowAvatar ?? true;
      _allowFamilyAccess = allowFamily ?? true;
      _tosAccepted = tosAccepted ?? false;

      if (tosAcceptedAtStr != null && tosAcceptedAtStr.isNotEmpty) {
        _tosAcceptedAt = DateTime.tryParse(tosAcceptedAtStr);
      } else {
        _tosAcceptedAt = null;
      }

      _isLoading = false;
    });

    // After local defaults are in place, try to override from Supabase.
    _loadFromSupabase();
  }

  Future<void> _saveToPrefs() async {
    final prefs = await SharedPreferences.getInstance();

    // If TOS transitions from false → true, set local timestamp once.
    if (_tosAccepted && _tosAcceptedAt == null) {
      _tosAcceptedAt = DateTime.now();
    }

    await prefs.setString(_kPrimaryLangKey, _primaryLanguageCode ?? 'en');
    await prefs.setStringList(
      _kSecondaryLangsKey,
      _secondaryLanguageCodes.toList(),
    );
    await prefs.setBool(_kAllowAvatarKey, _allowAvatarUsage);
    await prefs.setBool(_kAllowFamilyKey, _allowFamilyAccess);
    await prefs.setBool(_kTosAcceptedKey, _tosAccepted);
    if (_tosAcceptedAt != null) {
      await prefs.setString(
        _kTosAcceptedAtKey,
        _tosAcceptedAt!.toIso8601String(),
      );
    }

    // Also sync to Supabase (best-effort, non-blocking UX)
    await _saveToSupabase();

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Settings saved (local + Supabase).',
        ),
      ),
    );
    Navigator.of(context).pop();
  }

  // ---------------------------------------------------------------------------
  // Supabase: load & save (using YOUR actual columns)
  // ---------------------------------------------------------------------------

Future<void> _loadFromSupabase() async {
  final user = _client.auth.currentUser;
  if (user == null) {
    return;
  }

  try {
    final data = await _client
        .from('profiles')
        .select()
        .eq('id', user.id)
        .maybeSingle();

    // DEBUG: see what is actually stored in the DB
    print("DEBUG primary from DB = ${data?['preferred_language']}");
    print("DEBUG secondaries from DB = ${data?['supported_languages']}");

    if (data == null) return;

    setState(() {
      // ---- PRIMARY LANGUAGE (must be a code like 'en', 'th', etc.) ----
      final dbPrimary = data['preferred_language'] as String?;
      if (dbPrimary != null &&
          _allSupportedLanguageCodes.contains(dbPrimary)) {
        // Valid code from our curated list
        _primaryLanguageCode = dbPrimary;
      } else {
        // DB has something invalid like 'English' or null → fall back
        _primaryLanguageCode = 'en';
      }

      // ---- SECONDARY LANGUAGES (also codes only) ----
      final dbSecondaries = data['supported_languages'];
      if (dbSecondaries is List) {
        _secondaryLanguageCodes
          ..clear()
          ..addAll(
            dbSecondaries
                .whereType<String>()
                .where((code) => _allSupportedLanguageCodes.contains(code)),
          );
      }

      // ---- PERMISSIONS / TOS ----
      final dbAvatar = data['voice_avatar_consent'];
      if (dbAvatar is bool) _allowAvatarUsage = dbAvatar;

      final dbFamily = data['share_with_family'];
      if (dbFamily is bool) _allowFamilyAccess = dbFamily;

      final dbTos = data['tos_accepted'];
      if (dbTos is bool) _tosAccepted = dbTos;

      final ts = data['tos_accepted_at'];
      if (ts is String && ts.isNotEmpty) {
        _tosAcceptedAt = DateTime.tryParse(ts) ?? _tosAcceptedAt;
      }
    });
  } catch (e) {
    // ignore: avoid_print
    print('Error loading settings from Supabase: $e');
  }
}

  Future<void> _saveToSupabase() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      return;
    }

    try {
      final payload = <String, dynamic>{
        'id': user.id,
        'preferred_language': _primaryLanguageCode,
        'supported_languages': _secondaryLanguageCodes.toList(),
        'voice_avatar_consent': _allowAvatarUsage,
        'share_with_family': _allowFamilyAccess,
        'tos_accepted': _tosAccepted,
        'tos_accepted_at': _tosAcceptedAt?.toIso8601String(),
      };

      await _client.from('profiles').upsert(payload);
    } catch (e) {
      // ignore: avoid_print
      print('Error saving settings to Supabase: $e');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  String _labelForCode(String code) {
    final builtIn = _languages.firstWhere(
      (lang) => lang['code'] == code,
      orElse: () => {'code': code, 'label': code},
    );
    return builtIn['label'] ?? code;
  }

  List<String> get _allSupportedLanguageCodes {
    return _languages.map((lang) => lang['code']!).toList();
  }

  // Secondary chips = only codes the user has chosen
  List<String> get _secondaryChoices {
    final list = _secondaryLanguageCodes.toList();
    list.sort();
    return list;
  }

  // Dropdown for "Add secondary language" = all supported MINUS primary MINUS already selected
  List<String> get _addableSecondaryChoices {
    return _allSupportedLanguageCodes
        .where((code) =>
            code != _primaryLanguageCode &&
            !_secondaryLanguageCodes.contains(code))
        .toList()
      ..sort();
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _buildProfileCard(theme),
                const SizedBox(height: 16),
                _buildLanguageCard(theme),
                const SizedBox(height: 16),
                _buildPermissionsCard(theme),
                const SizedBox(height: 16),
                _buildTosCard(theme),
                const SizedBox(height: 80),
              ],
            ),
      bottomNavigationBar: _isLoading
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.save),
                    label: const Text('Save Settings'),
                    onPressed: () {
                      if (!_tosAccepted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text(
                              'Please accept the Terms of Service before saving.',
                            ),
                          ),
                        );
                        return;
                      }
                      _saveToPrefs();
                    },
                  ),
                ),
              ),
            ),
    );
  }

  Widget _buildProfileCard(ThemeData theme) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const CircleAvatar(
              child: Icon(Icons.person),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Your profile',
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Later, this will display your name, email, and donor id from Supabase.',
                    style: TextStyle(fontSize: 13),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLanguageCard(ThemeData theme) {
    final addable = _addableSecondaryChoices;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Language preferences',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 12),

            // Primary language dropdown
            DropdownButtonFormField<String>(
              decoration: const InputDecoration(
                labelText: 'Primary language',
                border: OutlineInputBorder(),
              ),
              value: _primaryLanguageCode,
              items: _languages
                  .map(
                    (lang) => DropdownMenuItem<String>(
                      value: lang['code'],
                      child: Text(lang['label'] ?? lang['code']!),
                    ),
                  )
                  .toList(),
              onChanged: (value) {
                if (value == null) return;
                setState(() {
                  _primaryLanguageCode = value;
                  // Ensure primary is not in secondary set
                  _secondaryLanguageCodes.remove(value);

                  // If chosen "to add" is no longer valid, clear it
                  if (_secondaryToAdd == value) {
                    _secondaryToAdd = null;
                  }
                });
              },
            ),

            const SizedBox(height: 16),

            // Secondary language chips
            const Text(
              'Your secondary languages',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
            ),
            const SizedBox(height: 8),
            _secondaryChoices.isEmpty
                ? const Text(
                    'No secondary languages selected yet.',
                    style: TextStyle(fontSize: 12, fontStyle: FontStyle.italic),
                  )
                : Wrap(
                    spacing: 8,
                    children: _secondaryChoices.map((code) {
                      final label = _labelForCode(code);
                      return FilterChip(
                        label: Text(label),
                        selected: true,
                        onSelected: (value) {
                          // Tapping toggles it off
                          setState(() {
                            if (!value) {
                              _secondaryLanguageCodes.remove(code);
                            }
                          });
                        },
                      );
                    }).toList(),
                  ),
            const SizedBox(height: 8),
            if (_secondaryChoices.isNotEmpty)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () {
                    setState(() {
                      _secondaryLanguageCodes.clear();
                    });
                  },
                  child: const Text('Clear all secondary languages'),
                ),
              ),

            const SizedBox(height: 16),

            // "Add secondary language" dropdown
            const Text(
              'Add secondary language',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    isExpanded: true,
                    decoration: const InputDecoration(
                      border: OutlineInputBorder(),
                      isDense: true,
                      contentPadding:
                          EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                    ),
                    value: addable.contains(_secondaryToAdd)
                        ? _secondaryToAdd
                        : null,
                    items: addable
                        .map(
                          (code) => DropdownMenuItem<String>(
                            value: code,
                            child: Text(_labelForCode(code)),
                          ),
                        )
                        .toList(),
                    onChanged: (value) {
                      setState(() {
                        _secondaryToAdd = value;
                      });
                    },
                    hint: const Text('Select a language to add'),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(
                  onPressed: _secondaryToAdd == null
                      ? null
                      : () {
                          setState(() {
                            _secondaryLanguageCodes.add(_secondaryToAdd!);
                            _secondaryToAdd = null;
                          });
                        },
                  child: const Text('Add'),
                ),
              ],
            ),

            const SizedBox(height: 8),
            const Text(
              'Only supported languages are listed here.\n'
              'We\'ll keep this list aligned with Google STT/TTS support.',
              style: TextStyle(fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPermissionsCard(ThemeData theme) {
    return Card(
      child: Column(
        children: [
          SwitchListTile(
            title: const Text('Allow AI avatar usage'),
            subtitle: const Text(
              'Permit your recorded stories to be used with an AI avatar in the future.',
            ),
            value: _allowAvatarUsage,
            onChanged: (value) {
              setState(() {
                _allowAvatarUsage = value;
              });
            },
          ),
          const Divider(height: 0),
          SwitchListTile(
            title: const Text('Allow family access'),
            subtitle: const Text(
              'Allow approved family members to view and interact with your stories.',
            ),
            value: _allowFamilyAccess,
            onChanged: (value) {
              setState(() {
                _allowFamilyAccess = value;
              });
            },
          ),
        ],
      ),
    );
  }

  Widget _buildTosCard(ThemeData theme) {
    String tosStatus;
    if (_tosAcceptedAt != null) {
      tosStatus =
          'Accepted on ${_tosAcceptedAt!.toLocal().toIso8601String().split(".").first}';
    } else if (_tosAccepted) {
      tosStatus = 'Accepted (time not recorded)';
    } else {
      tosStatus = 'Not yet accepted';
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Column(
          children: [
            CheckboxListTile(
              value: _tosAccepted,
              onChanged: (value) {
                setState(() {
                  _tosAccepted = value ?? false;
                  // Timestamp assignment happens in _saveToPrefs()
                });
              },
              title: const Text('I agree to the Terms of Service'),
              subtitle: Text(
                'Status: $tosStatus\nYou must agree before your settings can be saved.',
                style: const TextStyle(fontSize: 12),
              ),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content:
                          Text('Terms of Service screen not implemented yet.'),
                    ),
                  );
                },
                child: const Text('View Terms of Service'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
