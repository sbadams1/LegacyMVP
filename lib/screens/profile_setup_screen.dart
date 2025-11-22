// lib/screens/profile_setup_screen.dart

import 'package:flutter/material.dart';

import '../services/profile_service.dart';
import 'chat_screen.dart';

class ProfileSetupScreen extends StatefulWidget {
  const ProfileSetupScreen({super.key});

  @override
  State<ProfileSetupScreen> createState() => _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends State<ProfileSetupScreen> {
  final _formKey = GlobalKey<FormState>();

  final TextEditingController _legalNameController = TextEditingController();
  final TextEditingController _displayNameController = TextEditingController();
  final TextEditingController _countryController = TextEditingController();

  DateTime? _birthdate;
  bool _isSaving = false;
  bool _isLoadingProfile = true;

  final ProfileService _profileService = ProfileService();

  String _preferredLanguage = 'English';

  @override
  void initState() {
    super.initState();
    _loadExistingProfile();
  }

  Future<void> _loadExistingProfile() async {
    try {
      final profile = await _profileService.loadCurrentProfile();
      if (profile != null) {
        if (profile.legalName != null) {
          _legalNameController.text = profile.legalName!;
        }
        if (profile.displayName != null) {
          _displayNameController.text = profile.displayName!;
        }
        if (profile.countryRegion != null) {
          _countryController.text = profile.countryRegion!;
        }
        if (profile.birthdate != null) {
          _birthdate = profile.birthdate;
        }
        if (profile.preferredLanguage != null &&
            profile.preferredLanguage!.isNotEmpty) {
          _preferredLanguage = profile.preferredLanguage!;
        }
      }
    } catch (e) {
      // ignore, non-fatal
      // ignore: avoid_print
      print('Failed to load profile for setup: $e');
    } finally {
      if (mounted) {
        setState(() {
          _isLoadingProfile = false;
        });
      }
    }
  }

  @override
  void dispose() {
    _legalNameController.dispose();
    _displayNameController.dispose();
    _countryController.dispose();
    super.dispose();
  }

  Future<void> _pickBirthdate() async {
    final now = DateTime.now();
    final initial = _birthdate ??
        DateTime(now.year - 40, now.month, now.day);
    final firstDate = DateTime(now.year - 120);
    final lastDate = now;

    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: firstDate,
      lastDate: lastDate,
    );

    if (picked != null && mounted) {
      setState(() {
        _birthdate = picked;
      });
    }
  }

  Future<void> _saveProfile() async {
    if (!_formKey.currentState!.validate()) return;
    if (_birthdate == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select your birthdate.')),
      );
      return;
    }

    final legalName = _legalNameController.text.trim();
    final displayName = _displayNameController.text.trim();
    final country = _countryController.text.trim();
    final preferredLanguage = _preferredLanguage.trim();

    setState(() {
      _isSaving = true;
    });

    try {
      await _profileService.updateBasicsForCurrentUser(
        legalName: legalName,
        displayName: displayName,
        birthdate: _birthdate!,
        countryRegion: country,
        preferredLanguage: preferredLanguage,
      );

      if (!mounted) return;

      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => const ChatScreen(),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to save profile. Please try again. ($e)'),
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_isLoadingProfile) {
      return const Scaffold(
        body: Center(
          child: CircularProgressIndicator(),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Your Profile'),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Form(
            key: _formKey,
            child: ListView(
              children: [
                Text(
                  'Help us personalize your experience.',
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  'We use your full legal name for consent and record-keeping, '
                  'a display name for how the app and AI address you, and your '
                  'preferred language for conversations.',
                  style: theme.textTheme.bodyMedium,
                ),
                const SizedBox(height: 24),

                // Full legal name
                TextFormField(
                  controller: _legalNameController,
                  decoration: const InputDecoration(
                    labelText: 'Full legal name',
                    hintText: 'As it appears on official documents',
                    border: OutlineInputBorder(),
                  ),
                  textInputAction: TextInputAction.next,
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter your full legal name.';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),

                // Display name
                TextFormField(
                  controller: _displayNameController,
                  decoration: const InputDecoration(
                    labelText: 'Display name',
                    hintText: 'Nickname or how the app should address you',
                    border: OutlineInputBorder(),
                  ),
                  textInputAction: TextInputAction.next,
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter a display name.';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),

                // Preferred language
                DropdownButtonFormField<String>(
                  value: _preferredLanguage,
                  decoration: const InputDecoration(
                    labelText: 'Preferred language',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'English',
                      child: Text('English'),
                    ),
                    DropdownMenuItem(
                      value: 'Thai',
                      child: Text('Thai'),
                    ),
                    DropdownMenuItem(
                      value: 'Spanish',
                      child: Text('Spanish'),
                    ),
                    DropdownMenuItem(
                      value: 'Other',
                      child: Text('Other'),
                    ),
                  ],
                  onChanged: (value) {
                    if (value == null) return;
                    setState(() {
                      _preferredLanguage = value;
                    });
                  },
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please select a preferred language.';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),

                // Birthdate picker
                InkWell(
                  onTap: _pickBirthdate,
                  child: InputDecorator(
                    decoration: const InputDecoration(
                      labelText: 'Birthdate',
                      border: OutlineInputBorder(),
                    ),
                    child: Text(
                      _birthdate == null
                          ? 'Tap to select your birthdate'
                          : '${_birthdate!.year}-${_birthdate!.month.toString().padLeft(2, '0')}-${_birthdate!.day.toString().padLeft(2, '0')}',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: _birthdate == null
                            ? theme.hintColor
                            : theme.textTheme.bodyMedium?.color,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),

                // Country / region
                TextFormField(
                  controller: _countryController,
                  decoration: const InputDecoration(
                    labelText: 'Country / Region',
                    hintText: 'For example: Thailand, United States',
                    border: OutlineInputBorder(),
                  ),
                  textInputAction: TextInputAction.done,
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Please enter your country or region.';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 24),

                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _isSaving ? null : _saveProfile,
                    child: _isSaving
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Save and continue'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
