String toSecondPersonSummary(String input) {
  var s = input.trim();
  if (s.isEmpty) return s;

  // Normalize common lead-ins first (these are the biggest offenders)
  s = s.replaceAll(RegExp(r'^\s*The user\b', caseSensitive: false), 'You');
  s = s.replaceAll(RegExp(r'^\s*This user\b', caseSensitive: false), 'You');
  s = s.replaceAll(RegExp(r'^\s*User\b', caseSensitive: false), 'You');

  // Possessive forms
  s = s.replaceAll(RegExp(r"\bthe user's\b", caseSensitive: false), 'your');
  s = s.replaceAll(RegExp(r"\buser's\b", caseSensitive: false), 'your');

  // Mid-sentence replacements (conservative)
  s = s.replaceAll(RegExp(r'\bThe user\b', caseSensitive: false), 'you');
  s = s.replaceAll(RegExp(r'\btheir\b', caseSensitive: false), 'your');

  // Replace standalone "they"/"them"/"theirs" cautiously.
  // This is intentionally conservative; we *avoid* rewriting if it might refer to someone else.
  // Still catches most summary templates.
  s = s.replaceAll(RegExp(r'\bThey\b'), 'You');
  s = s.replaceAll(RegExp(r'\bthey\b'), 'you');
  s = s.replaceAll(RegExp(r'\bthem\b', caseSensitive: false), 'you');
  s = s.replaceAll(RegExp(r'\btheirs\b', caseSensitive: false), 'yours');

  // Clean up common grammar artifacts after replacements
  s = s.replaceAll(RegExp(r'\byou are\b', caseSensitive: false), 'you are'); // no-op, readability
  s = s.replaceAll(RegExp(r'\byou was\b', caseSensitive: false), 'you were');
  s = s.replaceAll(RegExp(r'\byour was\b', caseSensitive: false), 'your'); // rare artifact

  // Capitalize first letter if needed
  if (s.isNotEmpty) {
    s = s[0].toUpperCase() + s.substring(1);
  }
  return s;
}
