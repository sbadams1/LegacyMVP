part of 'chat_screen.dart';

class _ChatMessage {
  final String id;
  final String text;
  final bool isUser;
  final DateTime createdAt;

  final String? imageUrl;
  final String? videoUrl;

  _ChatMessage({
    required this.id,
    required this.text,
    required this.isUser,
    required this.createdAt,
    this.imageUrl,
    this.videoUrl,
  });
}

// TTS voice personalities – tone only (language is driven by profile locales)
class _TtsVoiceOption {
  final String id;
  final String label;

  /// Pitch for the synthesized voice (1.0 = neutral).
  final double pitch;

  /// Per-platform speech rate; normalized to avoid “3x speed” bug.
  final double rateAndroid;
  final double rateIOS;

  const _TtsVoiceOption({
    required this.id,
    required this.label,
    required this.pitch,
    required this.rateAndroid,
    required this.rateIOS,
  });
}

// Bottom sheet result for language learning config
class _LanguageLearningConfig {
  final String targetLocale; // e.g. "th-TH"
  final String learningLevel; // "beginner" | "intermediate" | "advanced"

  const _LanguageLearningConfig({
    required this.targetLocale,
    required this.learningLevel,
  });
}
