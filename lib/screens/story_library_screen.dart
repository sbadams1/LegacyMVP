import 'dart:convert';
import 'dart:math';



import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
// Shared helper to detect transcript-like text
bool looksLikeTranscript(String s) {
  final t = s.trim();
  if (t.isEmpty) return false;

  final lower = t.toLowerCase();

  // NEW: wake phrases / meta prompts that commonly come from transcript
  // but can be mistakenly treated as a summary.
  if (RegExp(r'^(hey|hi|hello)\s+(gemini|google)\b').hasMatch(lower)) return true;
  if (RegExp(r'^(play|start)\s+gemini\b').hasMatch(lower)) return true;
  if (RegExp(r'^(gemini)[,!\s]').hasMatch(lower)) return true;
  if (RegExp(r'\bare you there\??\b').hasMatch(lower)) return true;

  // Existing transcript markers
  if (lower.contains('assistant:') ||
      lower.contains('user:') ||
      lower.contains('[00:') ||
      RegExp(r'\b\d{1,2}:\d{2}:\d{2}\b').hasMatch(lower)) {
    return true;
  }

  final lines = t
      .split(RegExp(r'\r?\n'))
      .where((l) => l.trim().isNotEmpty)
      .toList();

  // Lots of short lines is typical transcript formatting
  if (lines.length >= 6) {
    final shortCount = lines.where((l) => l.trim().length < 50).length;
    if (shortCount / lines.length >= 0.6) return true;
  }

  // Speaker-prefixed lines repeated ("User: ...", "Assistant: ...", "Bob: ...")
  final prefixed = lines
      .where((l) => RegExp(r'^\s*\w[\w\s]{0,20}:').hasMatch(l))
      .length;
  if (prefixed >= 2) return true;

  // NEW: one-line "Gemini..." items are usually not summaries
  if (lower.contains('gemini') && t.length <= 220) return true;

  return false;
}

// Parse session_insights which may arrive as Map or JSON string.
Map<String, dynamic>? parseJsonMap(dynamic raw) {
  if (raw == null) return null;
  if (raw is Map<String, dynamic>) return raw;
  if (raw is Map) return Map<String, dynamic>.from(raw);
  if (raw is String) {
    final s = raw.trim();
    if (s.isEmpty) return null;
    try {
      final decoded = jsonDecode(s);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {}
  }
  return null;
}

bool _looksProceduralPlaceholder(String s) {
  final t = s.trim().toLowerCase();
  if (t.isEmpty) return false;

  // Common "tiny session" placeholders that should never override a real summary.
  if (t.contains('checked in briefly') && t.contains('did not record')) return true;
  if (t.contains('no detailed story') || t.contains('no story in this session')) return true;
  if (t.contains('no summary was captured')) return true;

  return false;
}

String pickSummaryFromSessionInsights(
  Map<String, dynamic>? si, {
  required bool full,
}) {
  if (si == null) return '';
  String pick(dynamic v) => (v is String) ? v.trim() : '';
  final reframed = parseJsonMap(si['reframed']);
  final rShort = pick(reframed?['short_summary']);
  final rFull = pick(reframed?['full_summary']);
  final siShort = pick(si['short_summary']);
  final siFull = pick(si['full_summary']);

  bool ok(String v, {bool allowPlaceholder = false}) {
    if (v.trim().isEmpty) return false;
    if (!allowPlaceholder && _looksProceduralPlaceholder(v)) return false;
    // Prefer to hide transcript-y content when possible.
    if (looksLikeTranscript(v)) return false;
    return true;
  }

  if (full) {
    // For full summaries, prefer top-level first; reframed is fallback.
    if (ok(siFull)) return siFull;
    if (ok(rFull)) return rFull;

    // If everything is transcript-like or placeholder, still return something non-empty as last resort.
    if (siFull.isNotEmpty && !_looksProceduralPlaceholder(siFull)) return siFull;
    if (rFull.isNotEmpty && !_looksProceduralPlaceholder(rFull)) return rFull;
    if (siFull.isNotEmpty) return siFull;
    if (rFull.isNotEmpty) return rFull;
    return '';
  } else {
    // For short summaries, prefer top-level first; reframed is fallback.
    if (ok(siShort)) return siShort;
    if (ok(rShort)) return rShort;

    // Fall back to full summary (top-level first).
    if (ok(siFull)) return siFull;
    if (ok(rFull)) return rFull;

    // Last resort: return something non-empty (but still try to avoid placeholders).
    if (siShort.isNotEmpty && !_looksProceduralPlaceholder(siShort)) return siShort;
    if (rShort.isNotEmpty && !_looksProceduralPlaceholder(rShort)) return rShort;
    if (siFull.isNotEmpty && !_looksProceduralPlaceholder(siFull)) return siFull;
    if (rFull.isNotEmpty && !_looksProceduralPlaceholder(rFull)) return rFull;
    if (siShort.isNotEmpty) return siShort;
    if (rShort.isNotEmpty) return rShort;
    if (siFull.isNotEmpty) return siFull;
    if (rFull.isNotEmpty) return rFull;
    return '';
  }
}




// Convert common third-person summary phrasing ("The user ...") into second-person ("You ...").
// UI-only: keeps your stored summaries intact while presenting them in the donor-facing voice you want.
String _secondPersonifySummary(String input) {
  var s = input.trim();
  if (s.isEmpty) return s;

  // Only transform if it clearly uses the third-person "The user" voice.
  // If it already starts with "You ", leave it alone.
  if (RegExp(r'^You\b', caseSensitive: false).hasMatch(s)) return s;
  if (!RegExp(r'\bThe user\b', caseSensitive: false).hasMatch(s) &&
      !RegExp(r'\bthe user\b', caseSensitive: false).hasMatch(s)) {
    return s;
  }

  // Handle leading subject with correct verb agreement.
  s = s.replaceFirst(RegExp(r'^The user is\b', caseSensitive: false), 'You are');
  s = s.replaceFirst(RegExp(r'^The user was\b', caseSensitive: false), 'You were');
  s = s.replaceFirst(RegExp(r'^The user has\b', caseSensitive: false), 'You have');
  s = s.replaceFirst(RegExp(r'^The user had\b', caseSensitive: false), 'You had');
  s = s.replaceFirst(RegExp(r'^The user does\b', caseSensitive: false), 'You do');
  s = s.replaceFirst(RegExp(r'^The user did\b', caseSensitive: false), 'You did');
  s = s.replaceFirst(RegExp(r'^The user can\b', caseSensitive: false), 'You can');
  s = s.replaceFirst(RegExp(r'^The user will\b', caseSensitive: false), 'You will');
  s = s.replaceFirst(RegExp(r'^The user\b', caseSensitive: false), 'You');

  // Replace remaining references conservatively.
  s = s.replaceAll(RegExp(r'\bthe user\b', caseSensitive: false), 'you');

  // Fix a couple of common agreement artifacts after replacement.
  s = s.replaceAll(RegExp(r'\bYou is\b'), 'You are');
  s = s.replaceAll(RegExp(r'\byou is\b'), 'you are');

  return s.trim();
}


class StoryLibraryScreen extends StatefulWidget {
  const StoryLibraryScreen({super.key});

  @override
  State<StoryLibraryScreen> createState() => _StoryLibraryScreenState();
}

class _StoryLibraryScreenState extends State<StoryLibraryScreen> {
  final SupabaseClient _client = Supabase.instance.client;

  bool _loading = true;
  String? _error;
  String? _rawIdSeedFromSummary;
  String? _conversationIdFromSummary;


  // ---------------------------------------------------------------------------
  // Story seeds (per-session "named stories") + longitudinal insights
  // ---------------------------------------------------------------------------
  bool _loadingSeeds = false;
  String? _seedError;
  List<Map<String, dynamic>> _storySeeds = const [];

  bool _loadingLongInsights = false;
  String? _longInsightsError;
  List<Map<String, dynamic>> _latestInsights = const [];
  List<Map<String, dynamic>> _rows = const [];

  // Donor UX: suppress summaries/insights until an explicit reveal moment.
  bool _revealPanels = false;
  int _revealTapCount = 0;

  @override
  void initState() {
    super.initState();
    _loadStories();
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Map<String, dynamic>? _asJsonMap(dynamic raw) {
    if (raw == null) return null;
    if (raw is Map<String, dynamic>) return raw;
    if (raw is String && raw.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) return decoded;
      } catch (_) {}
    }
    return null;
  }

  Map<String, dynamic>? _parseSessionInsights(dynamic raw) => _asJsonMap(raw);

  /// Prefer observations.session_key for "one card per donor session".
  /// If absent, fall back to memory_summary.conversation_id.
  String? _sessionKeyForRow(Map<String, dynamic> row) {
    final obs = _asJsonMap(row['observations']);
    final sk = (obs?['session_key'] as String? ?? '').trim();
    if (sk.isNotEmpty) return sk;

    final convId = (row['conversation_id'] as String? ?? '').trim();
    if (convId.isNotEmpty) return convId;

    return null;
  }

  String _dateLabelForRow(Map<String, dynamic> row) {
    final createdAt = (row['created_at'] as String? ?? '').trim();
    if (createdAt.isEmpty) return 'Session';
    // leave as-is; your backend already formats in ISO; the UI just needs a stable label
    return createdAt.replaceFirst('T', ' ').split('.').first;
  }

  
  bool _isLikelySessionSummaryRow(Map<String, dynamic> row) {
    // Prefer session_insights as the only source of truth for summaries.
    final si = parseJsonMap(row['session_insights']);

    final keySentence = (si?['key_sentence'] as String? ?? '').trim();
    final items = (si?['items'] as List<dynamic>? ?? const []);

    // If we have actual insight structure, it's a session summary row.
    if (keySentence.isNotEmpty || items.isNotEmpty) return true;

    final shortS = pickSummaryFromSessionInsights(si, full: false);
    final fullS = pickSummaryFromSessionInsights(si, full: true);
    final merged = shortS.isNotEmpty ? shortS : fullS;

    if (merged.isEmpty) return false;

    // Exclude language-learning tagged outputs if they ever land in memory_summary
    final lower = merged.toLowerCase();
    if (lower.contains('[l1]') ||
        lower.contains('[l2]') ||
        lower.contains('[lesson]') ||
        lower.contains('[vocab]') ||
        lower.contains('[drill]') ||
        lower.contains('[quiz]') ||
        lower.contains('[rom]')) {
      return false;
    }

    // Filter out the "mini transcript" / wake checks.
    if (lower.startsWith('hey gemini')) return false;

    // Too short = likely not a real session summary.
    if (merged.length < 140) return false;

    return true;
  }

  List<String> _buildHighlightBullets(Map<String, dynamic> row) {
    // Goal: always show human-readable bullets (no raw Map.toString()) and
    // surface "stories/themes/threads" when present.
    final highlights = <String>[];

    String? pickText(dynamic v) {
      if (v == null) return null;
      if (v is String) {
        final s = v.trim();
        return s.isEmpty ? null : s;
      }
      if (v is Map) {
        // Common shapes: {text: "..."} / {label: "..."} / {name: "..."} / {title: "..."}
        for (final k in const ['text', 'label', 'name', 'title', 'summary', 'value']) {
          final val = v[k];
          if (val is String) {
            final s = val.trim();
            if (s.isNotEmpty) return s;
          }
        }
        // Sometimes: {kind: theme, text: ..., strength: 0.8}
        final kind = (v['kind'] ?? '').toString().trim();
        final id = (v['id'] ?? '').toString().trim();
        if (kind.isNotEmpty) {
          final s = kind;
          // If we have at least kind/id, but no text, don't dump the map.
          return id.isNotEmpty ? '$s ($id)' : s;
        }
        return null;
      }
      // Avoid dumping objects like "{...}" into bullets.
      return null;
    }

    void addBullet(dynamic v) {
      if (highlights.length >= 5) return;
      final s = pickText(v);
      if (s == null) return;
      if (!highlights.contains(s)) highlights.add(s);
    }

    final obs = _asJsonMap(row['observations']) ?? const <String, dynamic>{};

    // Prefer explicit story/thread/theme lists if present.
    final stories = (obs['stories'] as List<dynamic>?) ?? const <dynamic>[];
    for (final st in stories) {
      if (highlights.length >= 5) break;
      addBullet(st);
    }

    final threads = (obs['threads'] as List<dynamic>?) ?? const <dynamic>[];
    for (final th in threads) {
      if (highlights.length >= 5) break;
      addBullet(th);
    }

    final themes = (obs['themes'] as List<dynamic>?) ?? const <dynamic>[];
    for (final th in themes) {
      if (highlights.length >= 5) break;
      addBullet(th);
    }

    // Session insights items (often richer than obs lists).
    final si = _asJsonMap(row['session_insights']);
    final items = (si?['items'] as List<dynamic>?) ?? const <dynamic>[];
    for (final it in items) {
      if (highlights.length >= 5) break;
      if (it is Map) {
        // If it has a usable text/label/title, take it.
        addBullet(it);
        continue;
      }
      addBullet(it);
    }

    return highlights.take(5).toList();
  }

  Widget _buildInsightsChip({
    required ThemeData theme,
    required dynamic sessionInsights,
    required VoidCallback onTap,
  }) {
    final si = _parseSessionInsights(sessionInsights);
    if (si == null) return const SizedBox.shrink();

    final keySentence = (si['key_sentence'] as String? ?? '').trim();
    final items = (si['items'] as List<dynamic>? ?? const []);
    if (keySentence.isEmpty && items.isEmpty) return const SizedBox.shrink();

    final label = keySentence.isNotEmpty ? keySentence : items.first.toString();

    return ActionChip(
      label: Text(
        label,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        softWrap: true,
        style: theme.textTheme.bodySmall,
      ),
      onPressed: onTap,
    );
  }



  // --------------------------------------------------------------
  // Longitudinal snapshot (read-only) helpers
  // Stored at memory_summary.observations.longitudinal_snapshot
  // --------------------------------------------------------------
  Map<String, dynamic>? _extractLongitudinalSnapshot(Map<String, dynamic> row) {
    final obs = _asJsonMap(row['observations']);
    final snap = obs?['longitudinal_snapshot'];
    if (snap is Map) return Map<String, dynamic>.from(snap as Map);
    return null;
  }

  List<String> _labelsFromList(dynamic v, {int max = 3}) {
    if (v is List) {
      final out = <String>[];
      for (final it in v) {
        if (it is Map && it['label'] is String) {
          final s = (it['label'] as String).trim();
          if (s.isNotEmpty) out.add(s);
        } else if (it is String) {
          final s = it.trim();
          if (s.isNotEmpty) out.add(s);
        }
        if (out.length >= max) break;
      }
      return out;
    }
    return const <String>[];
  }

  Widget _buildLongitudinalSnapshotPreview({
    required ThemeData theme,
    required Map<String, dynamic> row,
  }) {
    final snap = _extractLongitudinalSnapshot(row);
    if (snap == null) return const SizedBox.shrink();

    final emerging = _labelsFromList(snap['emerging_themes_month'], max: 3);

    // Recurring tensions can be list of strings or objects with label.
    final tensions = _labelsFromList(snap['recurring_tensions'], max: 2);

    // If neither emerging nor tensions exist, try to show a tiny "change" preview.
    final changed = snap['changed_since_last_week'];
    final changedUp = (changed is Map) ? _labelsFromList(changed['up'], max: 2) : const <String>[];
    final changedDown = (changed is Map) ? _labelsFromList(changed['down'], max: 2) : const <String>[];

    if (emerging.isEmpty && tensions.isEmpty && changedUp.isEmpty && changedDown.isEmpty) {
      return const SizedBox.shrink();
    }

    final lines = <String>[];
    if (emerging.isNotEmpty) {
      lines.add('Emerging: ${emerging.join(', ')}');
    }
    if (tensions.isNotEmpty) {
      lines.add('Tensions: ${tensions.join(' • ')}');
    } else if (changedUp.isNotEmpty || changedDown.isNotEmpty) {
      final parts = <String>[];
      if (changedUp.isNotEmpty) parts.add('More: ${changedUp.join(', ')}');
      if (changedDown.isNotEmpty) parts.add('Less: ${changedDown.join(', ')}');
      lines.add('Change: ${parts.join(' | ')}');
    }

    // Max 2 lines, subtle style.
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final line in lines.take(2))
            Text(
              line,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
        ],
      ),
    );
  }
  Future<void> _loadStories() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final user = _client.auth.currentUser;
    if (user == null) {
      setState(() {
        _loading = false;
        _error = 'You must be logged in to view your stories.';
      });
      return;
    }

    try {
      final res = await _client
          .from('memory_summary')
          .select(
              'id, conversation_id, raw_id, short_summary, observations, session_insights, created_at')
          .eq('user_id', user.id)
          .order('created_at', ascending: false);

      final rows = (res as List<dynamic>).cast<Map<String, dynamic>>();

      // Filter out non-session rows (the "mini transcript" one) and dedupe to 1 row per session.
      final seen = <String, Map<String, dynamic>>{};
      final deduped = <Map<String, dynamic>>[];

      for (final row in rows) {
        if (!_isLikelySessionSummaryRow(row)) continue;
        final key = _sessionKeyForRow(row);
        if (key == null) continue;
        if (seen.containsKey(key)) continue;
        seen[key] = row;
        deduped.add(row);
      }

      setState(() {
        _rows = deduped;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loading = false;
        _error = 'Failed to load stories: $e';
      });
    }
  }



  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: GestureDetector(
        onTap: () {
          // Hidden developer toggle: tap title 7x to reveal panels.
          _revealTapCount++;
          if (_revealTapCount >= 7) {
            setState(() {
              _revealPanels = !_revealPanels;
              _revealTapCount = 0;
            });
            _showSnack(_revealPanels
                ? 'Reveal panels enabled (dev)'
                : 'Reveal panels hidden');
          }
        },
        child: const Text('Story Library'),
      ),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _loadStories,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_error != null)
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(_error!, textAlign: TextAlign.center),
                  ),
                )
              : (_rows.isEmpty)
                  ? const Center(child: Text('No sessions yet.'))
                  : ListView.builder(
                      padding: const EdgeInsets.all(12),
                      itemCount: _rows.length,
                      itemBuilder: (context, index) {
                        final row = _rows[index];

                        final memorySummaryId =
                            (row['id'] as String? ?? '').trim();
                        final dateLabel = _dateLabelForRow(row);

                        
                        // UI reads summaries strictly from session_insights (canonical truth).
                        final siForSummary = parseJsonMap(row['session_insights']) ?? const <String, dynamic>{};
                        final sessionSummary =
                            pickSummaryFromSessionInsights(siForSummary, full: false).isNotEmpty
                                ? pickSummaryFromSessionInsights(siForSummary, full: false)
                                : (pickSummaryFromSessionInsights(siForSummary, full: true).isNotEmpty
                                    ? pickSummaryFromSessionInsights(siForSummary, full: true)
                                    : '(No session summary yet)');

                        final shortSummary = pickSummaryFromSessionInsights(siForSummary, full: false);
                        final fullSummary = pickSummaryFromSessionInsights(siForSummary, full: true);

                        final obs = _asJsonMap(row['observations']);
                        final rawSessionKey =
                            (obs?['session_key'] as String? ?? '').trim();

                        // For transcript, we MUST use memory_raw.conversation_id.
                        final convId =
                            (row['conversation_id'] as String? ?? '').trim();
                        final transcriptConversationId =
                            convId.isNotEmpty ? convId : rawSessionKey;
                        final rawIdSeed = (row['raw_id'] as String? ?? '').trim();

                        final highlights = _buildHighlightBullets(row);
                        final sessionInsights = row['session_insights'];

                        void openDetail() {
                          Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => EndSessionReviewScreen(
                                memorySummaryId: memorySummaryId,
                                sessionKey: rawSessionKey,
                                dateLabel: dateLabel,
                                fallbackTitle: dateLabel,
                                fallbackBody: sessionSummary,
                                shortSummary: shortSummary,
                                fullSummary: fullSummary,
                                sessionInsights: siForSummary,
                              ),
                            ),
                          );
                        }

                        return Card(
                          margin: const EdgeInsets.only(bottom: 12),
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                if (_revealPanels)
                                  Text(
                                    sessionSummary,
                                    style: theme.textTheme.bodyMedium,
                                  )
                                else
                                  Text(
                                    'Session saved.',
                                    style: theme.textTheme.bodyMedium,
                                  ),
                                const SizedBox(height: 10),

                                _buildLongitudinalSnapshotPreview(theme: theme, row: row),
                                const SizedBox(height: 8),

                                // (2) Insight chip (tap opens detail)
                                _buildInsightsChip(
                                  theme: theme,
                                  sessionInsights: sessionInsights,
                                  onTap: openDetail,
                                ),

                                // (3) Bullets
                                if (highlights.isNotEmpty) ...[
                                  const SizedBox(height: 10),
                                  for (final h in highlights)
                                    Padding(
                                      padding:
                                          const EdgeInsets.only(bottom: 4),
                                      child: Row(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          const Text('•  '),
                                          Expanded(child: Text(h)),
                                        ],
                                      ),
                                    ),
                                ],

                                const SizedBox(height: 10),

                                // (4) + (5) chips
                                Wrap(
                                  spacing: 10,
                                  runSpacing: 6,
                                  children: [
                                    ActionChip(
                                      label: const Text('Edit summary'),
                                      onPressed: openDetail,
                                    ),
                                    ActionChip(
                                      label: const Text('Edit transcript'),
                                      onPressed: () async {
                                        final conv =
                                            transcriptConversationId.trim();
                                        if (conv.isEmpty) {
                                          _showSnack(
                                              'No conversation_id found for this session transcript.');
                                          return;
                                        }
                                        await Navigator.of(context).push(
                                          MaterialPageRoute(
                                            builder: (_) => TranscriptScreen(
                                              sessionKey: conv,
                                               rawIdSeed: rawIdSeed,
                                              dateLabel: dateLabel.isNotEmpty
                                                  ? dateLabel
                                                  : 'Session',
                                            ),
                                          ),
                                        );
                                      },
                                    ),
                                  ],
                                ),

                                const SizedBox(height: 10),
                                Text(
                                  'Session: $dateLabel',
                                  style: theme.textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
    );
  }
}


class StoryDetailScreen extends StatefulWidget {
  final String memorySummaryId;
  final String? sessionKey; // from observations.session_key
  final String dateLabel;
  final String fallbackTitle;
  final String fallbackBody;
  final dynamic sessionInsights;

  // NEW: the values that the Story Library list used.
  final String shortSummary;
  final String fullSummary;

  const StoryDetailScreen({
  super.key,
  required this.memorySummaryId,
  required this.sessionKey,
  required this.dateLabel,
  required this.fallbackTitle,
  required this.fallbackBody,
  required this.shortSummary,
  required this.fullSummary,
  required this.sessionInsights, // ✅ REQUIRED
});

  @override
  State<StoryDetailScreen> createState() => _StoryDetailScreenState();
}

class _StoryDetailScreenState extends State<StoryDetailScreen> {
  final SupabaseClient _client = Supabase.instance.client;
  final TextEditingController _controller = TextEditingController();
  final ScrollController _storyScrollController = ScrollController();
  final ScrollController _insightsScrollController = ScrollController();
  bool _loading = true;
  bool _saving = false;
  bool _deleting = false;
  // Controls whether "reveal" panels (insights/seeds) are visible in this screen.
  // Default is false to keep donor UX clean.
  bool _revealPanels = false;

  String? _error;
  String? _rawIdSeedFromSummary;
  String? _conversationIdFromSummary;


  // ---------------------------------------------------------------------------
  // Story seeds (per-session "named stories") + longitudinal insights
  // ---------------------------------------------------------------------------
  bool _loadingSeeds = false;
  String? _seedError;
  List<Map<String, dynamic>> _storySeeds = const [];

  bool _loadingLongInsights = false;
  String? _longInsightsError;
  List<Map<String, dynamic>> _latestInsights = const [];

  @override
  void initState() {
    super.initState();
    _loadCuratedOrSummary();
    _kickoffSideLoads();
  }


  @override
  void dispose() {
    _controller.dispose();
    _storyScrollController.dispose();
    _insightsScrollController.dispose();
    super.dispose();
  }


  Map<String, dynamic>? _asJsonMap(dynamic raw) {
    if (raw == null) return null;
    if (raw is Map<String, dynamic>) return raw;
    if (raw is String && raw.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) return decoded;
      } catch (_) {}
    }
    return null;
  }

  void _kickoffSideLoads() {    // Story seeds are intentionally hidden in donor UX (and can be re-enabled later).
    // Longitudinal insights are cross-session (latest N for this user).
    _loadLatestLongitudinalInsights();
  }

  bool looksLikeTranscript(String s) {
    final t = s.trim();
    if (t.isEmpty) return false;

    final lower = t.toLowerCase();

    if (lower.contains('assistant:') ||
        lower.contains('user:') ||
        lower.contains('[00:') ||
        RegExp(r'\b\d{1,2}:\d{2}:\d{2}\b').hasMatch(lower)) {
      return true;
    }

    final lines =
      t.split(RegExp(r'\r?\n')).where((l) => l.trim().isNotEmpty).toList();

    if (lines.length >= 6) {
      final shortCount = lines.where((l) => l.trim().length < 50).length;
    if (shortCount / lines.length >= 0.6) return true;
  }

  final prefixed =
      lines.where((l) => RegExp(r'^\s*\w[\w\s]{0,20}:').hasMatch(l)).length;

  if (prefixed >= 2) return true;

  return false;
}
 
  Widget _buildSessionInsightsSection(ThemeData theme) {
  Map<String, dynamic>? si;

  final raw = widget.sessionInsights;
  if (raw is Map<String, dynamic>) {
    si = raw;
  } else if (raw is String && raw.trim().isNotEmpty) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) si = decoded;
    } catch (_) {}
  }

  if (si == null || si.isEmpty) return const SizedBox.shrink();

  final keySentence = (si['key_sentence'] as String? ?? '').trim();
  final items = (si['items'] as List<dynamic>? ?? const []);

  if (keySentence.isEmpty && items.isEmpty) return const SizedBox.shrink();

  // Collect “tags” from kinds
  final tags = <String>{};
  for (final it in items) {
    if (it is Map) {
      final kind = (it['kind'] as String? ?? '').trim();
      if (kind.isNotEmpty) tags.add(kind);
    }
  }

  return Container(
    margin: const EdgeInsets.only(bottom: 12),
    decoration: BoxDecoration(
      border: Border.all(color: theme.dividerColor),
      borderRadius: BorderRadius.circular(12),
    ),
    child: ExpansionTile(
      title: Text(
        'Open full session insights',
        style: theme.textTheme.titleMedium,
      ),
      childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      children: [
        if (keySentence.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(
            keySentence,
            style: theme.textTheme.bodyLarge?.copyWith(fontWeight: FontWeight.w600),
          ),
        ],

        if (tags.isNotEmpty) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: -8,
            children: tags.take(8).map((t) {
              return Chip(
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                label: Text(t),
              );
            }).toList(),
          ),
        ],

        
if (items.isNotEmpty) ...[
          const SizedBox(height: 10),

          // Group by kind so the user sees clear differentiation.
          Builder(builder: (context) {
            String prettyKind(String k) {
              final key = k.trim().toLowerCase();
              if (key.isEmpty) return 'Other';
              if (key == 'insight' || key == 'insights') return 'Insights';
              if (key == 'reflection' || key == 'reflections') return 'Reflections';
              if (key == 'pattern' || key == 'pattern_noticing' || key == 'pattern-noticing' || key == 'pattern noticing') {
                return 'Patterns';
              }
              if (key == 'theme' || key == 'themes') return 'Themes';
              if (key == 'value' || key == 'values') return 'Values';
              if (key == 'behavior' || key == 'behaviour') return 'Behaviors';
              if (key == 'trait' || key == 'traits') return 'Traits';
              return key.split(RegExp(r'[_\-\s]+')).map((w) {
                if (w.isEmpty) return w;
                return w[0].toUpperCase() + w.substring(1);
              }).join(' ');
            }

            final Map<String, List<String>> grouped = <String, List<String>>{};
            for (final it in items.take(80)) {
              if (it is! Map) continue;
              final text = (it['text'] as String? ?? '').trim();
              if (text.isEmpty) continue;
              final kindRaw = (it['kind'] as String? ?? '').trim();
              final kind = prettyKind(kindRaw);
              grouped.putIfAbsent(kind, () => <String>[]);
              grouped[kind]!.add(text);
            }
            if (grouped.isEmpty) return const SizedBox.shrink();

            return ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 520),
              child: Scrollbar(
                controller: _insightsScrollController,
                thumbVisibility: true,
                child: SingleChildScrollView(
                  controller: _insightsScrollController,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final entry in grouped.entries) ...[
                        const SizedBox(height: 6),
                        Text(
                          entry.key,
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                        ),
                        const SizedBox(height: 4),
                        for (final t in entry.value)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 4),
                            child: SelectableText('• $t'),
                          ),
                        const SizedBox(height: 10),
                      ],
                    ],
                  ),
                ),
              ),
            );
          }),
        ],
      ],
    ),
  );
}

  Future<void> _loadCuratedOrSummary() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final user = _client.auth.currentUser;
    if (user == null) {
      setState(() {
        _loading = false;
        _error = 'You must be logged in.';
      });
      return;
    }

    try {
      // 1) Load the latest summary text for this session from memory_summary.
      Map<String, dynamic>? summaryRes;
      try {
        final res = await _client
            .from('memory_summary')
            .select('short_summary, session_insights, raw_id, conversation_id')
            .eq('id', widget.memorySummaryId)
            .eq('user_id', user.id)
            .maybeSingle();

        if (res != null && res is Map<String, dynamic>) {
          summaryRes = res;
        }
      } catch (_) {
        // If this fetch fails for any reason, we'll fall back to the values
        // passed in from the Story Library list.
      }

      final shortSummaryFromDb =
          (summaryRes?['short_summary'] as String? ?? '').trim();
      final siFromDb = _asJsonMap(summaryRes?['session_insights']) ?? const <String, dynamic>{};
      String _fullFromSi(Map<String, dynamic> si) {
        final direct = (si['full_summary'] as String? ?? '').trim();
        if (direct.isNotEmpty) return direct;
        final reframed = si['reframed'];
        if (reframed is Map<String, dynamic>) {
          final rf = (reframed['full_summary'] as String? ?? '').trim();
          if (rf.isNotEmpty) return rf;
        }
        return '';
      }
      final fullSummaryFromDb = _fullFromSi(siFromDb);
      final rawIdSeedFromDb = (summaryRes?['raw_id'] ?? '').toString().trim();
      final conversationIdFromDb = (summaryRes?['conversation_id'] ?? '').toString().trim();

      _rawIdSeedFromSummary = rawIdSeedFromDb.isNotEmpty ? rawIdSeedFromDb : _rawIdSeedFromSummary;
      _conversationIdFromSummary = conversationIdFromDb.isNotEmpty ? conversationIdFromDb : _conversationIdFromSummary;


      final effectiveShortSummary = shortSummaryFromDb.isNotEmpty
          ? shortSummaryFromDb
          : widget.shortSummary.trim();

      final effectiveFullSummary = fullSummaryFromDb.isNotEmpty
          ? fullSummaryFromDb
          : widget.fullSummary.trim();

      String initialText = '';

      // Prefer actual summaries; avoid transcript-like text.
      final f = effectiveFullSummary.trim();
      final s = effectiveShortSummary.trim();
      if (f.isNotEmpty && !looksLikeTranscript(f)) {
        initialText = f;
      } else if (s.isNotEmpty && !looksLikeTranscript(s)) {
        initialText = s;
      } else {
        // Leave blank rather than showing transcript/meta.
        initialText = '';
      }

      _controller.text = initialText.isEmpty ? '' : _secondPersonifySummary(initialText);

      setState(() {
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loading = false;
        _error = 'Failed to load story: $e';
      });
    }
  }

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  // ---------------------------------------------------------------------------
  // Story seeds + longitudinal insights loaders
  // ---------------------------------------------------------------------------
  Future<void> _loadStorySeedsForSession(String conversationId) async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    setState(() {
      _loadingSeeds = true;
      _seedError = null;
    });

    try {
      final res = await _client
          .from('story_seeds')
          .select('id, title, seed_type, seed_text, created_at, conversation_id, summary_id')
          .eq('user_id', user.id)
          .eq('conversation_id', conversationId)
          .order('created_at', ascending: false);

      final list = <Map<String, dynamic>>[];
      if (res is List) {
        for (final row in res) {
          if (row is Map) {
            list.add(Map<String, dynamic>.from(row as Map));
          }
        }
      }

      if (!mounted) return;
      setState(() {
        _storySeeds = list;
        _loadingSeeds = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingSeeds = false;
        _seedError = 'Failed to load story seeds: $e';
      });
    }
  }

  Future<void> _loadLatestLongitudinalInsights() async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    setState(() {
      _loadingLongInsights = true;
      _longInsightsError = null;
    });

    try {
      final res = await _client
          .from('memory_insights')
          .select(
            'id, short_title, insight_text, insight_type, confidence, tags, created_at, source_session_ids',
          )
          .eq('user_id', user.id)
          .eq('insight_type', 'longitudinal_v2')
          .order('created_at', ascending: false)
          .limit(6);

      final list = <Map<String, dynamic>>[];
      if (res is List) {
        for (final row in res) {
          if (row is Map) list.add(Map<String, dynamic>.from(row as Map));
        }
      }

      if (!mounted) return;
      setState(() {
        _latestInsights = list;
        _loadingLongInsights = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingLongInsights = false;
        _longInsightsError = 'Failed to load insights: $e';
      });
    }
  }

  String _seedOneLiner(Map<String, dynamic> seed) {
    // Try a few common fields inside seed_text
    final sj = seed['seed_text'];
    Map<String, dynamic>? m;
    if (sj is Map<String, dynamic>) {
      m = sj;
    } else if (sj is String && sj.trim().isNotEmpty) {
      try {
        final decoded = jsonDecode(sj);
        if (decoded is Map) m = Map<String, dynamic>.from(decoded as Map);
      } catch (_) {}
    }

    final candidates = <String>[
      (m?['key_sentence'] as String?) ?? '',
      (m?['summary'] as String?) ?? '',
      (m?['one_liner'] as String?) ?? '',
      (m?['what_happened'] as String?) ?? '',
      (m?['story'] as String?) ?? '',
    ];

    for (final c in candidates) {
      final t = c.trim();
      if (t.isNotEmpty) return t;
    }
    return '';
  }

    Widget _buildStorySeedsSection(ThemeData theme) {
    return const SizedBox.shrink();
  }

  Widget _buildLongitudinalInsightsSection(ThemeData theme) {
    if (!_revealPanels) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Insights over time (latest)',
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 8),

        if (_loadingLongInsights)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_longInsightsError != null)
          Text(
            _longInsightsError!,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.error,
            ),
          )
        else if (_latestInsights.isEmpty)
          Text(
            'No longitudinal insights yet — record a few meaningful sessions to build durable themes.',
            style: theme.textTheme.bodyMedium,
          )
        else
          ..._latestInsights.take(6).map((it) {
            final title = ((it['short_title'] as String?) ?? '').trim();
            final text = ((it['insight_text'] as String?) ?? '').trim();
            final kind = ((it['insight_type'] as String?) ?? '').trim();

            return Card(
              margin: const EdgeInsets.only(bottom: 10),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            title.isNotEmpty ? title : '(Insight)',
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        if (kind.isNotEmpty)
                          Chip(
                            visualDensity: VisualDensity.compact,
                            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            label: Text(kind),
                          ),
                      ],
                    ),
                    if (text.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(text, style: theme.textTheme.bodyMedium),
                    ],
                  ],
                ),
              ),
            );
          }).toList(),

        const SizedBox(height: 12),
      ],
    );
  }



  Future<void> _saveCurated() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in to save.');
      return;
    }

    final text = _controller.text;
    final trimmed = text.trim();
    if (trimmed.isEmpty) {
      _showSnack('Story text cannot be empty.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    try {
      // 1) Upsert into memory_curated
      await _client.from('memory_curated').upsert(
        {
          'user_id': user.id,
          'memory_summary_id': widget.memorySummaryId,
          'curated_text': trimmed,
        },
        onConflict: 'user_id,memory_summary_id',
      );

      // 2) Note: memory_summary.full_summary column was removed; curated text is stored in memory_curated only.
// 3) Kick off an insights rebuild
      try {
        await _client.functions
            .invoke('rebuild-insights', body: {'user_id': user.id});
      } catch (e) {
        // Non-fatal
        // ignore: avoid_print
        print('rebuild-insights failed: $e');
      }

      _showSnack('Curated story saved.');

      setState(() {
        _saving = false;
      });

      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } catch (e) {
      setState(() {
        _saving = false;
        _error = 'Failed to save curated story: $e';
      });
    }
  }

  Future<void> _deleteSession() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in to delete.');
      return;
    }

    // Confirm with the user
    final confirm = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this session?'),
        content: const Text(
          'This will delete the curated story, the session summary, and '
          'the underlying memories associated with this session. '
          'This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirm != true) {
      return;
    }

    setState(() {
      _deleting = true;
      _error = null;
    });

    try {
      // 1) Delete from memory_curated (if exists)
      await _client
          .from('memory_curated')
          .delete()
          .eq('user_id', user.id)
          .eq('memory_summary_id', widget.memorySummaryId);

      // 2) Delete from memory_raw using the sessionKey if we have it
      if (widget.sessionKey != null && widget.sessionKey!.isNotEmpty) {
        await _client
            .from('memory_raw')
            .delete()
            .eq('user_id', user.id)
            .eq('conversation_id', widget.sessionKey!);
      }

      // 3) Delete from memory_summary
      await _client
          .from('memory_summary')
          .delete()
          .eq('id', widget.memorySummaryId)
          .eq('user_id', user.id);

      // 4) Trigger insights rebuild (best-effort)
      try {
        await _client.functions
            .invoke('rebuild-insights', body: {'user_id': user.id});
      } catch (e) {
        // Non-fatal
        // ignore: avoid_print
        print('rebuild-insights after delete failed: $e');
      }

      _showSnack('Story deleted.');

      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } catch (e) {
      setState(() {
        _deleting = false;
        _error = 'Failed to delete story: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text('Session: ${widget.dateLabel}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.fact_check),
            tooltip: 'Session Review',
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => EndSessionReviewScreen(
                    memorySummaryId: widget.memorySummaryId,
                    sessionKey: (widget.sessionKey ?? ''),
                    dateLabel: widget.dateLabel,
                    fallbackTitle: 'Session Review',
                    fallbackBody: (widget.fullSummary.isNotEmpty
                            ? widget.fullSummary
                            : widget.shortSummary)
                        .trim(),
                    shortSummary: widget.shortSummary,
                    fullSummary: widget.fullSummary,
                    sessionInsights: (widget.sessionInsights is Map)
                        ? (widget.sessionInsights as Map).cast<String, dynamic>()
                        : (widget.sessionInsights ?? const {}),
                  ),
                ),
              );
            },
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: CircularProgressIndicator(),
            )
          : _error != null
              ? Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    _error!,
                    style: theme.textTheme.bodyMedium,
                  ),
                )
              : Builder(
                  builder: (context) {
                    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
                    final h = MediaQuery.of(context).size.height;
                    final editorH = (h * 0.32).clamp(180.0, 360.0);
                    return ListView(
                      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + bottomInset),
                      children: [
                        _buildSessionInsightsSection(theme),                        _buildLongitudinalInsightsSection(theme),
                        Text(
                          'Your story for this session',
                          style: theme.textTheme.titleMedium,
                        ),
                        const SizedBox(height: 8),
                        SizedBox(
                          height: editorH,
                          child: TextField(
                            controller: _controller,
                            scrollController: _storyScrollController,
                            scrollPhysics: const BouncingScrollPhysics(),
                            maxLines: null,
                            expands: false,
                            keyboardType: TextInputType.multiline,
                            decoration: const InputDecoration(
                              border: OutlineInputBorder(),
                              alignLabelWithHint: true,
                            ),
                            style: theme.textTheme.bodyMedium,
                          ),
                        ),
                        const SizedBox(height: 16),
                        if (_error != null) ...[
                          Text(
                            _error!,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.error,
                            ),
                          ),
                          const SizedBox(height: 12),
                        ],
                        Wrap(
                          spacing: 12,
                          runSpacing: 8,
                          alignment: WrapAlignment.end,
                          children: [
                            OutlinedButton.icon(
                              onPressed: () {
                                final rawIdSeed = (_rawIdSeedFromSummary ?? '').toString().trim();
                                final sk = (widget.sessionKey ?? _conversationIdFromSummary ?? '').toString().trim();
                                Navigator.of(context).push(
                                  MaterialPageRoute(
                                    builder: (_) => TranscriptScreen(
                                      sessionKey: sk,
                                      dateLabel: widget.dateLabel,
                                      rawIdSeed: rawIdSeed.isEmpty ? null : rawIdSeed,
                                    ),
                                  ),
                                );
                              },
                              icon: const Icon(Icons.article_outlined),
                              label: const Text('Transcript'),
                            ),
                            TextButton.icon(
                              onPressed: _deleting ? null : _deleteSession,
                              icon: _deleting
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : const Icon(Icons.delete_outline),
                              label: const Text('Delete'),
                            ),
                            ElevatedButton.icon(
                              onPressed: _saving ? null : _saveCurated,
                              icon: _saving
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : const Icon(Icons.save),
                              label: const Text('Save curated story'),
                            ),
                          ],
                        ),
                      ],
                    );
                  },
                )
    );
  }
}

class MemoryEditorScreen extends StatefulWidget {
  final String memoryId;
  final String initialText;
  final String dateLabel;

  const MemoryEditorScreen({
    super.key,
    required this.memoryId,
    required this.initialText,
    required this.dateLabel,
  });

  @override
  State<MemoryEditorScreen> createState() => _MemoryEditorScreenState();
}

class _MemoryEditorScreenState extends State<MemoryEditorScreen> {
  final SupabaseClient _client = Supabase.instance.client;
  late TextEditingController _controller;
  bool _saving = false;

  String _uuidV4() {
    final rnd = Random.secure();
    final bytes = List<int>.generate(16, (_) => rnd.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    String hx(int b) => b.toRadixString(16).padLeft(2, '0');
    final s = bytes.map(hx).join();
    return '${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20)}';
  }

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialText);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }


  Future<void> _save() async {
    setState(() {
      _saving = true;
    });

    try {
      final user = _client.auth.currentUser;
      if (user == null) {
        throw Exception('You must be logged in to save edits.');
      }

      final edited = _controller.text.trim();
      if (edited.isEmpty) {
        throw Exception('Edit cannot be empty.');
      }

      // 1) Persist directly to memory_raw (authoritative transcript)
      await _client
          .from('memory_raw')
          .update({'content': edited})
          .eq('user_id', user.id)
          .eq('id', widget.memoryId);

      // 2) Best-effort: also log into memory_raw_edits (do NOT block save if this fails)
      try {
        await _client
            .from('memory_raw_edits')
            .update({
              'is_current': false,
              'superseded_at': DateTime.now().toIso8601String(),
            })
            .eq('user_id', user.id)
            .eq('raw_id', widget.memoryId)
            .eq('is_current', true);

        final nowIso = DateTime.now().toIso8601String();
        await _client.from('memory_raw_edits').insert({
          'id': _uuidV4(),
          'user_id': user.id,
          'raw_id': widget.memoryId,
          'edited_content': edited,
          'editor_user_id': user.id,
          'is_current': true,
          'created_at': nowIso,
        });
      } catch (e) {
        // ignore: avoid_print
        print('⚠️ memory_raw_edits logging failed (non-fatal): $e');
      }

      // Look up conversation_id (session key) for optional targeted rebuild
      String? conversationId;
      try {
        final Map<String, dynamic>? row = await _client
            .from('memory_raw')
            .select('conversation_id')
            .eq('user_id', user.id)
            .eq('id', widget.memoryId)
            .maybeSingle();
        final convVal = row?['conversation_id'];
        if (convVal is String && convVal.trim().isNotEmpty) {
          conversationId = convVal.trim();
        }
      } catch (_) {
        // ignore
      }

      // 3) Best-effort: rebuild only this session summary (preferred).
      if (conversationId != null && conversationId!.isNotEmpty) {
        try {
          await _client.functions.invoke(
            'rebuild-session-summary',
            body: {'user_id': user.id, 'conversation_id': conversationId},
          );
        } catch (e) {
          final msg = e.toString();
          if (!(msg.contains('NOT_FOUND') || msg.contains('404'))) {
            // ignore: avoid_print
            print('rebuild-session-summary failed after edit: $e');
          }
        }
      } else {
        // Fallback: previous behavior (heavier) if we couldn't identify session
        try {
          await _client.functions.invoke(
            'rebuild-insights',
            body: {'user_id': user.id},
          );
        } catch (e) {
          // ignore: avoid_print
          print('rebuild-insights failed after memory edit: $e');
        }
      }

      if (!mounted) return;
      Navigator.of(context).pop(edited);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed to save memory: $e'),
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.dateLabel.isNotEmpty
              ? 'Edit memory – ${widget.dateLabel}'
              : 'Edit memory',
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.save),
            onPressed: _saving ? null : _save,
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: TextField(
          controller: _controller,
          maxLines: null,
          minLines: 8,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            labelText: 'Memory text',
            alignLabelWithHint: true,
          ),
          style: theme.textTheme.bodyMedium,
        ),
      ),
    );
  }
}

// Simple “insights” view built on memory_insights
class InsightsScreen extends StatefulWidget {
  const InsightsScreen({super.key});

  @override
  State<InsightsScreen> createState() => _InsightsScreenState();
}

class _InsightsScreenState extends State<InsightsScreen> {
  final SupabaseClient _client = Supabase.instance.client;
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _insights = [];

  @override
  void initState() {
    super.initState();
    _loadInsights();
  }

  Future<void> _loadInsights() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final user = _client.auth.currentUser;
    if (user == null) {
      setState(() {
        _loading = false;
        _error = 'You must be logged in to view insights.';
      });
      return;
    }

    try {
      final res = await _client
          .from('memory_insights')
          .select(
            // New schema from rebuild-insights:
            // - short_title: brief label
            // - insight_text: main descriptive text
            // - insight_type / confidence / tags: optional metadata
            'id, short_title, insight_text, insight_type, confidence, tags, created_at, source_session_ids',
          )
          .eq('user_id', user.id)
          .order('created_at', ascending: false);

      final list = (res as List<dynamic>? ?? <dynamic>[]);

      setState(() {
        _insights = list.map((e) => e as Map<String, dynamic>).toList();
        _loading = false;
      });
    } catch (e) {

      setState(() {
        _error = 'Failed to load insights: $e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Insights'),
      ),
      body: RefreshIndicator(
        onRefresh: _loadInsights,
        child: _loading
            ? const Center(
                child: CircularProgressIndicator(),
              )
            : _error != null
                ? ListView(
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Text(
                          _error!,
                          style: theme.textTheme.bodyMedium,
                        ),
                      ),
                    ],
                  )
                : _insights.isEmpty
                    ? ListView(
                        children: const [
                          Padding(
                            padding: EdgeInsets.all(16),
                            child: Text(
                              'No longitudinal insights yet. Even if you have lots of memories overall, '
                              'this only appears after a few recent sessions are “meaningful” (not short/procedural). '
                              'Record a longer reflective session, then refresh this screen.',
                            ),
                          ),
                        ],
                      )
                    : ListView.builder(
                        itemCount: _insights.length,
                        itemBuilder: (context, index) {
                          final row = _insights[index];

                          // New schema from rebuild-insights:
                          // - short_title: brief label for the insight
                          // - insight_text: full descriptive text
                          final title =
                              (row['short_title'] as String? ?? '').trim();
                          final summary =
                              (row['insight_text'] as String? ?? '').trim();

                          final createdAtStr =
                              row['created_at'] as String? ?? '';
                          String dateLabel = '';
                          if (createdAtStr.isNotEmpty) {
                            final createdAt =
                                DateTime.tryParse(createdAtStr)?.toLocal();
                            if (createdAt != null) {
                              dateLabel =
                                  '${createdAt.year}-${createdAt.month.toString().padLeft(2, '0')}-${createdAt.day.toString().padLeft(2, '0')}';
                            } else {
                              dateLabel = createdAtStr;
                            }
                          }

                          return ListTile(
                            title: Text(
                              title.isNotEmpty ? title : '(Untitled insight)',
                              style: theme.textTheme.titleMedium,
                            ),
                            subtitle: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                if (dateLabel.isNotEmpty)
                                  Text(
                                    dateLabel,
                                    style: theme.textTheme.bodySmall,
                                  ),
                                if (summary.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    summary,
                                    style: theme.textTheme.bodyMedium,
                                  ),
                                ],
                              ],
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}





class SessionHistoryScreen extends StatefulWidget {
  const SessionHistoryScreen({super.key});

  @override
  State<SessionHistoryScreen> createState() => _SessionHistoryScreenState();
}

class _SessionHistoryScreenState extends State<SessionHistoryScreen> {
  final SupabaseClient _client = Supabase.instance.client;
  bool _loading = true;
  String _error = '';
  List<Map<String, dynamic>> _rows = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final uid = _client.auth.currentUser?.id;
    if (uid == null || uid.isEmpty) {
      setState(() { _loading = false; _error = 'Not signed in.'; });
      return;
    }
    setState(() { _loading = true; _error = ''; });
    try {
      final res = await _client
          .from('memory_summary')
          .select('id, created_at, short_summary, session_insights, conversation_id, raw_id')
          .eq('user_id', uid)
          .order('created_at', ascending: false)
          .limit(50);
      if (res is List) {
        _rows = res.cast<Map<String, dynamic>>();
      } else {
        _rows = const [];
      }
    } catch (e) {
      _error = e.toString();
      _rows = const [];
    }
    if (!mounted) return;
    setState(() { _loading = false; });
  }

  String _formatTs(dynamic ts) {
    try {
      final d = DateTime.parse(ts.toString()).toLocal();
      return '${d.year.toString().padLeft(4,'0')}-${d.month.toString().padLeft(2,'0')}-${d.day.toString().padLeft(2,'0')} '
             '${d.hour.toString().padLeft(2,'0')}:${d.minute.toString().padLeft(2,'0')}';
    } catch (_) {
      return ts?.toString() ?? '';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Session history'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error.isNotEmpty
              ? Center(child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(_error),
                ))
              : ListView.separated(
                  padding: const EdgeInsets.all(12),
                  itemCount: _rows.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (context, i) {
                    final r = _rows[i];
                    final id = (r['id'] ?? '').toString();
                    final date = _formatTs(r['created_at']);
                    
                    final si = parseJsonMap(r['session_insights']) ?? const <String, dynamic>{};
                    final displayShort = pickSummaryFromSessionInsights(si, full: false);
                    final fullS = pickSummaryFromSessionInsights(si, full: true);

                    return Card(
                      child: ListTile(
                        title: Text(date.isEmpty ? 'Session' : date),
                          subtitle: Text(displayShort.isEmpty ? '(no summary)' : displayShort, maxLines: 4, overflow: TextOverflow.ellipsis),
                        onTap: () {
                          final sessionKey = (r['conversation_id'] ?? '').toString().trim();
                          Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => EndSessionReviewScreen(
                                memorySummaryId: id,
                                sessionKey: sessionKey.isEmpty ? id : sessionKey,
                                dateLabel: date,
                                fallbackTitle: 'Session',
                                fallbackBody: displayShort,
                                shortSummary: displayShort,
                                fullSummary: fullS,
                                sessionInsights: si,
                              ),
                            ),
                          );
                        },
                      ),
                    );
                  },
                ),
    );
  }
}

class TranscriptScreen extends StatefulWidget {
  final String sessionKey;
  final String dateLabel;
  final String? rawIdSeed;

  const TranscriptScreen({
    super.key,
    required this.sessionKey,
    required this.dateLabel,
    this.rawIdSeed,
  });

  @override
  State<TranscriptScreen> createState() => _TranscriptScreenState();
}

class _TranscriptScreenState extends State<TranscriptScreen> {
  final SupabaseClient _client = Supabase.instance.client;
  bool _loading = true;
  String? _error;
  final List<Map<String, dynamic>> _rows = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final user = _client.auth.currentUser;
    if (user == null) {
      setState(() {
        _loading = false;
        _error = 'Not logged in.';
      });
      return;
    }

    try {
      // First try: use the passed key as memory_raw.conversation_id.
      // IMPORTANT: PostgREST will throw if we compare a UUID column to "".
      List<dynamic> res = <dynamic>[];
      final sessionKey = widget.sessionKey.trim();
      if (sessionKey.isNotEmpty && sessionKey != 'n/a') {
        res = await _client
            .from('memory_raw')
            .select('id, content, source, created_at, conversation_id')
            .eq('user_id', user.id)
            .eq('conversation_id', sessionKey)
            .order('created_at', ascending: true)
            .order('id', ascending: true);
      }

      // Fallback: if nothing found and we have a raw_id seed, look up the real conversation_id.
      if ((res as List).isEmpty && widget.rawIdSeed != null && widget.rawIdSeed!.trim().isNotEmpty) {
        final seedRes = await _client
            .from('memory_raw')
            .select('conversation_id')
            .eq('user_id', user.id)
            .eq('id', widget.rawIdSeed!.trim())
            .maybeSingle();

        final conv = (seedRes is Map<String, dynamic>)
            ? (seedRes['conversation_id'] as String? ?? '').trim()
            : '';

        if (conv.isNotEmpty) {
          res = await _client
              .from('memory_raw')
              .select('id, content, source, created_at, conversation_id')
              .eq('user_id', user.id)
              .eq('conversation_id', conv)
              .order('created_at', ascending: true)
              .order('id', ascending: true);
        }
      }


      final list = (res as List<dynamic>? ?? <dynamic>[])
          .map((e) => e as Map<String, dynamic>)
          .toList();

      setState(() {
        _rows
          ..clear()
          ..addAll(list);
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _loading = false;
        _error = 'Failed to load transcript: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.dateLabel),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_error != null)
              ? Center(child: Text(_error!))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                  itemCount: _rows.length,
                  itemBuilder: (context, i) {
                    final r = _rows[i];
                    final rawId = (r['id'] as String?) ?? '';
                    final text = (r['content'] as String? ?? '').trim();
                    final src = (r['source'] as String? ?? '').trim();

                    if (rawId.isEmpty) return const SizedBox.shrink();

                    return Card(
                      margin: const EdgeInsets.only(bottom: 10),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    src.isEmpty ? 'Turn' : src,
                                    style: Theme.of(context).textTheme.bodySmall,
                                  ),
                                ),
                                IconButton(
                                  tooltip: 'Edit this turn',
                                  icon: const Icon(Icons.edit),
                                  onPressed: () async {
                                    final updated = await Navigator.of(context).push<String>(
                                      MaterialPageRoute(
                                        builder: (_) => MemoryEditorScreen(
                                          memoryId: rawId,
                                          initialText: text,
                                          dateLabel: widget.dateLabel,
                                        ),
                                      ),
                                    );
                                    if (updated != null) {
                                      _showSnack('Saved.');
                                      _load();
                                    }
                                  },
                                ),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(text),
                          ],
                        ),
                      ),
                    );
                  },
                ),
    );
  }
}

// ============================================================================
// END OF SESSION REVIEW (Dedicated screen)
// ============================================================================

class EndSessionReviewScreen extends StatefulWidget {
  final String memorySummaryId;
  final String sessionKey;
  final String dateLabel;

  // Fallbacks (used when DB row is not yet available)
  final String fallbackTitle;
  final String fallbackBody;

  // Optional payloads (from server or DB)
  final String shortSummary;
  final String fullSummary;
  final Map<String, dynamic> sessionInsights;

  const EndSessionReviewScreen({
    super.key,
    required this.memorySummaryId,
    required this.sessionKey,
    required this.dateLabel,
    required this.fallbackTitle,
    required this.fallbackBody,
    required this.shortSummary,
    required this.fullSummary,
    required this.sessionInsights,
  });

  @override
  State<EndSessionReviewScreen> createState() => _EndSessionReviewScreenState();
}

class _EndSessionReviewScreenState extends State<EndSessionReviewScreen> {
  final SupabaseClient _client = Supabase.instance.client;
  Future<List<Map<String, dynamic>>>? _longitudinalFuture;
  
  String get whatCapturedText {
    final ins = _effectiveInsights();
    final short = pickSummaryFromSessionInsights(ins, full: false).trim();
    final full = pickSummaryFromSessionInsights(ins, full: true).trim();

    final candidate = short.isNotEmpty ? short : full;
    if (candidate.isEmpty) return '—';

    // UI normalization only (do NOT compute alternative truth).
    return normalizeSummaryVoice(candidate);
  }

  /// Light UI-only normalization for summary text (presentation only).
  /// This must NEVER compute a different “truth”; it only cleans formatting.
  String normalizeSummaryVoice(String input) {
    var t = input.trim();
    // Collapse whitespace.
    t = t.replaceAll(RegExp(r'\s+'), ' ');
    // Remove leading bullet characters if present.
    t = t.replaceAll(RegExp(r'^[\-•\u2022]+\s*'), '');
    return t;
  }



  Future<void> _editStoryText() async {
    // Ensure we have something to edit (prefer current displayed story text)
    final initial = whatCapturedText.trim();
    final controller = TextEditingController(text: initial);

    final result = await showDialog<String>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Edit story'),
          content: SizedBox(
            width: double.maxFinite,
            child: TextField(
              controller: controller,
              maxLines: 10,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                hintText: 'Edit the story summary for this session…',
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(null),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(controller.text),
              child: const Text('Save'),
            ),
          ],
        );
      },
    );

    if (result == null) return;
    final trimmed = result.trim();
    if (trimmed.isEmpty) return;

    final user = _client.auth.currentUser;
    if (user == null) return;

    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      await _client
          .from('memory_summary')
          .update({'short_summary': trimmed, 'session_insights': {..._effectiveInsights(), 'short_summary': trimmed}})
          .eq('id', widget.memorySummaryId)
          .eq('user_id', user.id);

      // Update local cached row so the UI updates immediately
      setState(() {
        _row = {
          ...?_row,
          'short_summary': trimmed,
        };
      });
    } catch (e) {
      setState(() {
        _error = 'Failed to save edit: $e';
      });
    } finally {
      setState(() {
        _loading = false;
      });
    }
  }

  Future<void> _saveCuratedStory() async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    final trimmed = whatCapturedText.trim();
    if (trimmed.isEmpty) return;

    setState(() {
      _loading = true;
      _error = '';
    });

    try {

      // Persist the edited story text back to memory_summary (canonical),
      // and keep short_summary in sync when the edited text is reasonably short.
      final existingShort = pickSummaryFromSessionInsights(_effectiveInsights(), full: false).trim().isNotEmpty
          ? pickSummaryFromSessionInsights(_effectiveInsights(), full: false).trim()
          : widget.shortSummary;
      final shortCandidate = trimmed.length <= 500 ? trimmed : existingShort;

      // Canonical truth lives in session_insights (and curated lives in memory_curated).
      // Do NOT touch memory_summary.full_summary here.
      final mergedSI = <String, dynamic>{
        ..._effectiveInsights(),
        // Keep short_summary mirrored for list UIs.
        'short_summary': shortCandidate,
        // Store curated text in session_insights for easy downstream access.
        'curated_story': trimmed,
        'curated_at': DateTime.now().toUtc().toIso8601String(),
      };

      await _client
          .from('memory_summary')
          .update({
            'short_summary': shortCandidate,
            'session_insights': mergedSI,
            'updated_at': DateTime.now().toUtc().toIso8601String(),
          })
          .eq('id', widget.memorySummaryId)
          .eq('user_id', user.id);

      // Update local cached row so the UI updates immediately
      setState(() {
        _row = {
          ...?_row,
          'short_summary': shortCandidate,
          'session_insights': mergedSI,
        };
      });


      // Upsert curated text for this memory_summary row
      await _client.from('memory_curated').upsert(
        {
          'user_id': user.id,
          'memory_summary_id': widget.memorySummaryId,
          'curated_text': trimmed,
        },
        onConflict: 'user_id,memory_summary_id',
      );

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Curated story saved.')),
        );
      }
    } catch (e) {
      setState(() {
        _error = 'Failed to save curated story: $e';
      });
    } finally {
      setState(() {
        _loading = false;
      });
    }
  }


  bool _loading = false;
  String _error = '';

  Map<String, dynamic>? _row; // memory_summary row

  @override
  void initState() {
    super.initState();
    _longitudinalFuture = _fetchLongitudinalInsights();
    _load();
  }

  Future<void> _load() async {
    final id = widget.memorySummaryId.trim();
    if (id.isEmpty || id == 'n/a') {
      // We can still render from fallbacks.
      return;
    }

    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      final client = Supabase.instance.client;
      final res = await client
          .from('memory_summary')
          .select('id, created_at, short_summary, observations, session_insights, conversation_id, raw_id')
          .eq('id', id)
          .limit(1);

      if (res is List && res.isNotEmpty) {
        _row = Map<String, dynamic>.from(res.first as Map);
      } else {
        _error = 'Session summary not found yet.';
      }
    } catch (e) {
      _error = 'Failed to load session review: $e';
    } finally {
      if (!mounted) return;
      setState(() {
      _loading = false;
      _longitudinalFuture = _fetchLongitudinalInsights();
    });
}
  }

  Future<List<Map<String, dynamic>>> _fetchLongitudinalInsights() async {
    final uid = _client.auth.currentUser?.id;
    if (uid == null || uid.isEmpty) return <Map<String, dynamic>>[];
    try {
      final res = await _client
          .from('memory_insights')
          .select('short_title, insight_text, created_at')
          .eq('user_id', uid)
          .eq('insight_type', 'longitudinal_v2')
          .order('created_at', ascending: false)
          .limit(5);
      if (res is List) return res.cast<Map<String, dynamic>>();
    } catch (_) {}
    return <Map<String, dynamic>>[];
  }



  Map<String, dynamic> _effectiveInsights() {
    final fromDb = _row?['session_insights'];
    if (fromDb is Map) return Map<String, dynamic>.from(fromDb as Map);
    return widget.sessionInsights;
  }

  
  String _effectiveShortSummary() {
    final ins = _effectiveInsights();
    final s = pickSummaryFromSessionInsights(ins, full: false).trim();
    if (s.isNotEmpty) return s;
    if (widget.shortSummary.trim().isNotEmpty) return widget.shortSummary.trim();
    return widget.fallbackBody.trim();
  }

  String _effectiveFullSummary() {
    final ins = _effectiveInsights();
    final s = pickSummaryFromSessionInsights(ins, full: true).trim();
    if (s.isNotEmpty) return s;
    if (widget.fullSummary.trim().isNotEmpty) return widget.fullSummary.trim();
    return widget.fallbackBody.trim();
  }

Map<String, dynamic>? _reframed() {
    final ins = _effectiveInsights();
    final r = ins['reframed'];
    if (r is Map) return Map<String, dynamic>.from(r as Map);
    return null;
  }

  List<String> _stringList(dynamic v) {
    if (v is List) {
      return v
          .whereType<String>()
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList(growable: false);
    }
    return const <String>[];
  }

  Widget _bulletList(List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      children: items
          .map((t) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('•  '),
                    Expanded(child: Text(t)),
                  ],
                ),
              ))
          .toList(growable: false),
    );
  }

  
  Widget _buildLongitudinalSnapshotSection(BuildContext context) {
    final theme = Theme.of(context);
    final obs = parseJsonMap(_row?["observations"]) ?? const <String, dynamic>{};
    final snapRaw = obs["longitudinal_snapshot"];
    if (snapRaw is! Map) return const SizedBox.shrink();
    final snap = Map<String, dynamic>.from(snapRaw as Map);
    // Prefer an already-written observational paragraph if present.
    String? snapshotText;
    final st0 = snap["snapshot_text"];
    if (st0 is String && st0.trim().isNotEmpty) {
      snapshotText = st0.trim();
    } else {
      final v2 = snap["v2"];
      if (v2 is Map) {
        final blocks = (v2["blocks"] is Map) ? Map<String, dynamic>.from(v2["blocks"] as Map) : null;
        final st1 = blocks?["snapshot_text"];
        if (st1 is String && st1.trim().isNotEmpty) snapshotText = st1.trim();
      }
    }


    // If this session was not eligible, we still show the snapshot, but it is "from prior sessions".
    final eligibility = (obs["eligibility"] is Map) ? Map<String, dynamic>.from(obs["eligibility"] as Map) : const <String, dynamic>{};
    final bool fromPriorSessions = (eligibility["eligible"] == false);

    List<String> labelsFrom(dynamic v, {int max = 3}) {
      if (v is List) {
        final out = <String>[];
        for (final it in v) {
          if (it is Map && it["label"] != null) {
            final s = it["label"].toString().trim();
            if (s.isNotEmpty) out.add(s);
          } else if (it is String) {
            final s = it.trim();
            if (s.isNotEmpty) out.add(s);
          }
          if (out.length >= max) break;
        }
        return out;
      }
      return const <String>[];
    }

    List<String> receiptsFrom(dynamic v, {int max = 6}) {
      if (v is List) {
        final out = <String>[];
        for (final it in v) {
          final s = it?.toString().trim() ?? "";
          if (s.isNotEmpty && !out.contains(s)) out.add(s);
          if (out.length >= max) break;
        }
        return out;
      }
      return const <String>[];
    }

    String? _bestReceiptForLabel({
      required String label,
      required Map<String, dynamic> receiptsByLabel,
      required List<dynamic> recurringTensionsRaw,
    }) {
      // Prefer receipts embedded in recurring_tensions (if present for this label).
      for (final it in recurringTensionsRaw) {
        if (it is Map) {
          final l = (it["label"] ?? '').toString().trim();
          if (l == label) {
            final rs = receiptsFrom(it["receipts"], max: 6);
            if (rs.isNotEmpty) {
              rs.sort((a, b) => a.length.compareTo(b.length));
              return rs.first;
            }
          }
        }
      }

      final rs = receiptsFrom(receiptsByLabel[label], max: 6);
      if (rs.isEmpty) return null;

      // Heuristic: pick the shortest, but avoid boilerplate-y openers when possible.
      String scoreKey(String s) {
        final t = s.toLowerCase().trim();
        if (t.startsWith('tension') || t.startsWith('balance') || t.startsWith('seeking') || t.startsWith('trying') || t.startsWith('suspecting') || t.startsWith('potential')) {
          return '1';
        }
        return '0';
      }

      rs.sort((a, b) {
        final sa = scoreKey(a);
        final sb = scoreKey(b);
        if (sa != sb) return sa.compareTo(sb);
        return a.length.compareTo(b.length);
      });
      return rs.first;
    }

    Widget _section({required String title, required List<String> labels, required Map<String, dynamic> receiptsByLabel, required List<dynamic> recurringTensionsRaw}) {
      if (labels.isEmpty) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            ...labels.map((label) {
              final best = _bestReceiptForLabel(
                label: label,
                receiptsByLabel: receiptsByLabel,
                recurringTensionsRaw: recurringTensionsRaw,
              );
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
                    if (best != null) ...[
                      const SizedBox(height: 2),
                      Text(best, style: theme.textTheme.bodySmall, softWrap: true),
                    ],
                  ],
                ),
              );
            }),
          ],
        ),
      );
    }

    final emerging = labelsFrom(snap["emerging_themes_month"], max: 3);

    // recurring_tensions is a list of objects with label + receipts.
    final recurringTensionsRaw = (snap["recurring_tensions"] is List) ? List<dynamic>.from(snap["recurring_tensions"] as List) : const <dynamic>[];
    final tensions = labelsFrom(recurringTensionsRaw, max: 3);

    final changed = snap["changed_since_last_week"];
    final changedUp = (changed is Map) ? labelsFrom(changed["up"], max: 3) : const <String>[];
    final changedDown = (changed is Map) ? labelsFrom(changed["down"], max: 3) : const <String>[];

    final receiptsByLabel = (snap["receipts_by_label"] is Map)
        ? Map<String, dynamic>.from(snap["receipts_by_label"] as Map)
        : <String, dynamic>{};

    final hasAnything = emerging.isNotEmpty || tensions.isNotEmpty || changedUp.isNotEmpty || changedDown.isNotEmpty || receiptsByLabel.isNotEmpty;
    if (!hasAnything) return const SizedBox.shrink();

    // Per-label expandable receipts.
    // To reduce clutter, only surface the most supported labels (top-N).
    final receiptLabelTiles = <Widget>[];
    if (receiptsByLabel.isNotEmpty) {
      bool isInList(List<String> xs, String v) => xs.any((x) => x.toLowerCase() == v.toLowerCase());

      int labelScore(String label) {
        final rs = receiptsFrom(receiptsByLabel[label], max: 50);
        // Dart doesn't have a String(...) constructor; always use toString().
        final inTensions = recurringTensionsRaw.any((it) => ((it as dynamic)?['label'] ?? '').toString().trim() == label);
        final inEmerging = isInList(emerging, label);
        final base = rs.length;
        return base + (inTensions ? 6 : 0) + (inEmerging ? 3 : 0);
      }

      final labels = receiptsByLabel.keys.toList()
        ..sort((a, b) => labelScore(b).compareTo(labelScore(a)));

      // Show only the top labels; everything else stays hidden behind the DB.
      final maxLabels = 6;
      for (final label in labels.take(maxLabels)) {
        final rs = receiptsFrom(receiptsByLabel[label], max: 8);
        if (rs.isEmpty) continue;
        final best = _bestReceiptForLabel(label: label, receiptsByLabel: receiptsByLabel, recurringTensionsRaw: recurringTensionsRaw);
        receiptLabelTiles.add(
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            childrenPadding: const EdgeInsets.only(left: 12, bottom: 6),
            title: Text(label, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
            subtitle: (best == null)
                ? null
                : Text(
                    best,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall,
                  ),
            children: [
              for (final r in rs)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('•  '),
                      Expanded(child: Text(r, style: theme.textTheme.bodySmall, softWrap: true)),
                    ],
                  ),
                ),
            ],
          ),
        );
      }
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.black12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(child: Text("What keeps showing up", style: theme.textTheme.titleSmall)),
              if (fromPriorSessions)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Text(
                    "From prior sessions",
                    style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54, fontStyle: FontStyle.italic),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),

          if (snapshotText != null) ...[
            Text(snapshotText!, style: theme.textTheme.bodyMedium, softWrap: true),
            const SizedBox(height: 12),
          ],

          // Prefer v2 narrative blocks when available (less taxonomy, more recognition).
          (() {
            final v2 = (snap["v2"] is Map) ? Map<String, dynamic>.from(snap["v2"] as Map) : null;
            final resonance = (v2 != null && v2["resonance"] is Map) ? Map<String, dynamic>.from(v2["resonance"] as Map) : <String, dynamic>{};
            final blocks = (v2 != null && v2["blocks"] is Map) ? Map<String, dynamic>.from(v2["blocks"] as Map) : <String, dynamic>{};
            final emergingText = (blocks["emerging_pattern"] ?? "").toString().trim();
            final tensionText = (blocks["tension_you_are_carrying"] ?? "").toString().trim();
            final valueText = (blocks["underlying_value"] ?? "").toString().trim();
            final hasV2 = emergingText.isNotEmpty || tensionText.isNotEmpty || valueText.isNotEmpty;
            final passed = (resonance["passed"] == true);

            Widget buildBlock(String title, String text) {
              if (text.trim().isEmpty) return const SizedBox.shrink();
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text(text, style: theme.textTheme.bodySmall, softWrap: true),
                ],
              );
            }

            if (hasV2) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!passed)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(
                        "Draft (still learning your voice)",
                        style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54, fontStyle: FontStyle.italic),
                      ),
                    ),
                  buildBlock("Emerging Pattern", emergingText),
                  const SizedBox(height: 10),
                  buildBlock("Tension You're Carrying", tensionText),
                  const SizedBox(height: 10),
                  buildBlock("Underlying Value", valueText),
                  const SizedBox(height: 6),
                ],
              );
            }

            // Fallback: no extra taxonomy.
            return const SizedBox.shrink();
})(),

          if (receiptLabelTiles.isNotEmpty) ...[
            const SizedBox(height: 6),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text("Evidence", style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: receiptLabelTiles),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }


  @override
  Widget build(BuildContext context) {
    final reframed = _reframed();
    final shortSummary = _effectiveShortSummary();
    final fullSummary = _effectiveFullSummary();

    final reflections = _stringList(reframed?['reflections']);
    final rare = _stringList(reframed?['rare_insights']);

    return Scaffold(
      appBar: AppBar(
        title: const Text('End of session'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _loading ? null : _load,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(_error, style: const TextStyle(color: Colors.red)),
                    ),

                  // Session Review header
                  Text('Session Review', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 8),

                  // What you captured
                  Text('Your story for this session', style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.black12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(whatCapturedText),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 10,
                    runSpacing: 8,
                    children: [
                      OutlinedButton.icon(
                        onPressed: _loading ? null : _editStoryText,
                        icon: const Icon(Icons.edit),
                        label: const Text('Edit'),
                      ),
                      ElevatedButton.icon(
                        onPressed: _loading ? null : _saveCuratedStory,
                        icon: const Icon(Icons.save),
                        label: const Text('Save curated story'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton.icon(
                      onPressed: () {
                        final convId = (_row?['conversation_id'] ?? '').toString().trim();
                        final effectiveSessionKey = convId.isNotEmpty ? convId : widget.sessionKey;
                        final rawIdSeed = (_row?['raw_id'] ?? '').toString().trim();
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => TranscriptScreen(
                              sessionKey: effectiveSessionKey,
                              dateLabel: widget.dateLabel,
                              rawIdSeed: rawIdSeed,
                            ),
                          ),
                        );
                      },
                      icon: const Icon(Icons.subject),
                      label: const Text('Transcript'),
                    ),
                  ),
                  const SizedBox(height: 16),

                  _buildLongitudinalSnapshotSection(context),
                  const SizedBox(height: 16),

                  // Reframed insights (only show sections that exist; avoid forcing)
                  if (reflections.isNotEmpty) ...[
                  Text('Reflections', style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 8),
                  _bulletList(reflections),
                  const SizedBox(height: 16),
                ],
                if (rare.isNotEmpty) ...[
                  Text('Rare insights', style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 8),
                  _bulletList(rare),
                  const SizedBox(height: 16),
                ],

                FutureBuilder<List<Map<String, dynamic>>>(
                  future: _longitudinalFuture,
                  builder: (context, snap) {
                    final items = (snap.data ?? const <Map<String, dynamic>>[]);
                    if (items.isEmpty) return const SizedBox.shrink();
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Longitudinal insights', style: Theme.of(context).textTheme.titleSmall),
                        const SizedBox(height: 8),
                        ...items.map((m) {
                          final title = (m['short_title'] ?? '').toString().trim();
                          final text = (m['insight_text'] ?? '').toString().trim();
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                if (title.isNotEmpty)
                                  Text(title, style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                                if (text.isNotEmpty) Text(text),
                              ],
                            ),
                          );
                        }),
                        const SizedBox(height: 8),
                      ],
                    );
                  },
                ),



                ],
              ),
            ),
    );
  }
}