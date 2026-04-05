import 'dart:convert';
import 'dart:async';
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

  // 1) Normalize leading third-person subject → second person
  s = s.replaceAll(RegExp(r'^\s*The user\b', caseSensitive: false), 'You');
  s = s.replaceAll(RegExp(r'^\s*This user\b', caseSensitive: false), 'You');
  s = s.replaceAll(RegExp(r'^\s*User\b', caseSensitive: false), 'You');

  // 2) Possessive forms
  s = s.replaceAll(RegExp(r"\bthe user's\b", caseSensitive: false), 'your');
  s = s.replaceAll(RegExp(r"\buser's\b", caseSensitive: false), 'your');

  // 3) If sentence now refers to "You", normalize dependent pronouns
  //    This prevents: "You ... their ..." / "You ... They ..."
  s = s.replaceAll(RegExp(r'\bthey are\b', caseSensitive: false), 'you are');
  s = s.replaceAll(RegExp(r'\bthey\b', caseSensitive: false), 'you');
  s = s.replaceAll(RegExp(r'\btheir\b', caseSensitive: false), 'your');
  s = s.replaceAll(RegExp(r'\bthem\b', caseSensitive: false), 'you');
  s = s.replaceAll(RegExp(r'\btheirs\b', caseSensitive: false), 'yours');

  // 4) Grammar cleanup
  s = s.replaceAll(RegExp(r'\byou was\b', caseSensitive: false), 'you were');

  // 5) Capitalize first letter
  if (s.isNotEmpty) {
    s = s[0].toUpperCase() + s.substring(1);
  }

  return s;
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

      final rows = (res as List<dynamic>).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();

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
 
  Future<void> _rebuildSummariesAndFacts() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      // Single rebuild path: ALWAYS run the end-session pipeline via ai-brain.
      // This re-generates memory_summary, extracts facts, and captures stories.
      final rows = List<Map<String, dynamic>>.from(_rows);
      if (rows.isEmpty) {
        _showSnack('No sessions to rebuild.');
        setState(() {
          _loading = false;
        });
        return;
      }

      int ok = 0;
      int fail = 0;
      for (final row in rows) {
        final convId = (row['conversation_id'] as String? ?? '').trim();
        if (convId.isEmpty) continue;
        try {
          await _client.functions.invoke(
            'ai-brain',
            body: {
              'op': 'rebuild_conversation_artifacts',
              'conversation_id': convId,
              'end_session': true,
              'message_text': '__END_SESSION__',
            },
          );
          ok++;
        } catch (_) {
          fail++;
        }
      }

      if (!mounted) return;
      _showSnack('Rebuild complete. OK=$ok, failed=$fail. Refreshing…');
      await _loadStories();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Rebuild failed: $e';
      });
      _showSnack('Rebuild failed.');
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
          IconButton(
            tooltip: 'Rebuild session artifacts',
            icon: const Icon(Icons.auto_fix_high),
            onPressed: _rebuildSummariesAndFacts,
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
                                    _secondPersonifySummary(sessionSummary),
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
      // 3) Single rebuild path: best-effort re-run end-session artifacts for this session.
      final convId = (widget.sessionKey ?? '').trim();
      if (convId.isNotEmpty) {
        try {
          await _client.functions.invoke(
            'ai-brain',
            body: {
              'op': 'rebuild_conversation_artifacts',
              'conversation_id': convId,
              'end_session': true,
              'message_text': '__END_SESSION__',
            },
          );
        } catch (e) {
          // Non-fatal
          // ignore: avoid_print
          print('ai-brain rebuild failed after curated save (non-fatal): $e');
        }
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

      // No rebuild call here (session is deleted). Keep behavior deterministic.

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
                         ? Map<String, dynamic>.from(widget.sessionInsights as Map)
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

      // 2.5) Best-effort: mark impacted story seeds stale so future retells reflect edits.
      // This runs server-side because it uses overlap queries across story_seeds/story_recall.
      try {
        await _client.functions.invoke(
          'mark-story-seeds-stale',
          body: {
            'user_id': user.id,
            'edited_raw_ids': [widget.memoryId],
            'reason': 'memory_raw_edit',
          },
        );
      } catch (e) {
        // ignore: avoid_print
        print('mark-story-seeds-stale failed (non-fatal): $e');
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

      // Fallback: derive conversation_id from memory_summary using raw_id if needed.
      if (conversationId == null || conversationId!.isEmpty) {
        try {
          final Map<String, dynamic>? sRow = await _client
              .from('memory_summary')
              .select('conversation_id')
              .eq('user_id', user.id)
              .eq('raw_id', widget.memoryId)
              .maybeSingle();
          final v = sRow?['conversation_id'];
          if (v is String && v.trim().isNotEmpty) {
            conversationId = v.trim();
          }
        } catch (_) {
          // ignore
        }
      }

      // 3) Single rebuild path: rebuild this session artifacts via ai-brain.
      if (conversationId != null && conversationId!.isNotEmpty) {
        try {
          await _client.functions.invoke(
            'ai-brain',
            body: {
              'op': 'rebuild_conversation_artifacts',
              'conversation_id': conversationId,
              'end_session': true,
              'message_text': '__END_SESSION__',
            },
          );
        } catch (e) {
          final msg = e.toString();
          if (!(msg.contains('NOT_FOUND') || msg.contains('404'))) {
            // ignore: avoid_print
            print('ai-brain session rebuild failed after edit: $e');
          }
        }
       } else {
         // No conversation id: don't do a bulk rebuild (avoids non-deterministic partial rebuild paths).
         // ignore: avoid_print
         print('ai-brain rebuild skipped after edit: missing conversation_id');
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
        _insights = list.map((e) => Map<String, dynamic>.from(e as Map)).toList();
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
    _load().whenComplete(() {
      // Phase B writes fact_candidates asynchronously. Wire the UI to fetch immediately,
      // then listen for inserts (with a light polling fallback).
      _initFactsPipeline();
    });
  }

  @override
  void dispose() {
    _stopFactsPipeline();
    super.dispose();
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

   // NOTE: no-op stubs to satisfy builds if this screen calls them.
   // Facts display wiring lives in EndSessionReviewScreen below.
   void _initFactsPipeline() {}
   void _stopFactsPipeline() {}
 
  Future<void> _rebuildSessions() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('You must be logged in.')),
      );
      return;
    }

    setState(() {
      _loading = true;
      _error = '';
    });

    int ok = 0;
    int fail = 0;

    try {
      // Rebuild artifacts for the sessions currently shown in the list.
      // (Fast, predictable. If you later want "all sessions", add paging.)
      for (final row in _rows) {
        final convId = (row['conversation_id'] ?? '').toString().trim();
        if (convId.isEmpty) continue;

        try {
          await _client.functions.invoke(
            'ai-brain',
            body: {
              'op': 'rebuild_conversation_artifacts',
              'conversation_id': convId,
              'end_session': true,
              'message_text': '__END_SESSION__',
            },
          );
          ok++;
        } catch (_) {
          fail++;
        }
      }
    } finally {
      if (!mounted) return;
      setState(() {
        _loading = false;
      });
    }

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Rebuild complete. OK=$ok, failed=$fail. Refreshing…')),
    );
    await _load();
  }

String _formatTs(dynamic ts) {
  try {
    final d = DateTime.parse(ts.toString()).toLocal();
    return '${d.year.toString().padLeft(4, '0')}-'
           '${d.month.toString().padLeft(2, '0')}-'
           '${d.day.toString().padLeft(2, '0')} '
           '${d.hour.toString().padLeft(2, '0')}:'
           '${d.minute.toString().padLeft(2, '0')}';
  } catch (_) {
    return '';
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
          IconButton(
            tooltip: 'Rebuild session artifacts',
            onPressed: _loading ? null : _rebuildSessions,
            icon: const Icon(Icons.auto_fix_high),
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
                     final fromInsights = pickSummaryFromSessionInsights(si, full: false).trim();
                     final fromColumn = (r['short_summary'] ?? '').toString().trim();
                     final displayShort = fromInsights.isNotEmpty ? fromInsights : fromColumn;
                     final fullS = pickSummaryFromSessionInsights(si, full: true);
 
                     return Card(
                       child: ListTile(
                         title: Text(date.isEmpty ? 'Session' : date),
                         subtitle: Text(
                           displayShort.isEmpty ? '(no summary)' : displayShort,
                           maxLines: 4,
                           overflow: TextOverflow.ellipsis,
                         ),
                        onTap: () async {
                          final sessionKey = (r['conversation_id'] ?? '').toString().trim();
                          final changed = await Navigator.of(context).push<bool>(
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
                          if (changed == true) {
                            await _load();
                          }
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
 
  Future<void> _rebuildSessions() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in.');
      return;
    }

    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      final rows = List<Map<String, dynamic>>.from(_rows);
      if (rows.isEmpty) {
        _showSnack('No sessions to rebuild.');
        setState(() {
          _loading = false;
        });
        return;
      }

      int ok = 0;
      int fail = 0;
      for (final row in rows) {
        final convId = (row['conversation_id'] as String? ?? '').trim();
        if (convId.isEmpty) continue;
        try {
          await _client.functions.invoke(
            'ai-brain',
            body: {
              'op': 'rebuild_conversation_artifacts',
              'conversation_id': convId,
              'end_session': true,
              'message_text': '__END_SESSION__',
            },
          );
          ok++;
        } catch (_) {
          fail++;
        }
      }

      if (!mounted) return;
      _showSnack('Rebuild complete. OK=$ok, failed=$fail. Refreshing…');
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Rebuild failed: $e';
      });
      _showSnack('Rebuild failed.');
    }
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

        final conv = (seedRes is Map)
            ? ((seedRes?['conversation_id'] ?? '')).toString().trim()
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
          .map((e) => Map<String, dynamic>.from(e as Map))
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

  // Facts UI behavior
  static const int _factsPreviewLimit = 4;
  bool _showAllFacts = false;

  // Phase B facts (fact_candidates): fetch + realtime subscription + polling fallback
  bool _loadingFactCandidates = false;
  String? _factsError;
  List<Map<String, dynamic>> _factCandidates = const <Map<String, dynamic>>[];

   StreamSubscription<List<Map<String, dynamic>>>? _factsSub;
   Timer? _factsPollTimer;
 
  // Lock/value state is stored in user_facts_receipts, not in fact_candidates.
  final Map<String, bool> _lockByFactKey = <String, bool>{};
  final Map<String, dynamic> _valueByFactKey = <String, dynamic>{};

   Future<void> _fetchFactCandidates({bool silent = false}) async {
     final uid = _client.auth.currentUser?.id;
     if (uid == null || uid.isEmpty) return;
    final convId = _effectiveConversationId();
    if (convId.isEmpty) return;

    if (!silent) {
      setState(() {
        _loadingFactCandidates = true;
        _factsError = null;
      });
    }

    try {
      final res = await _client
          .from('fact_candidates')
          .select('id, fact_key_guess, fact_key_canonical, value_json, confidence, status, extracted_at')
          .eq('user_id', uid)
          .eq('conversation_id', convId)
          .inFilter('status', ['captured', 'active', 'conflict'])
          .order('extracted_at', ascending: true);

      final rows = (res is List)
          ? res.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList()
          : <Map<String, dynamic>>[];

       if (!mounted) return;
       setState(() {
         _factCandidates = rows;
         _factsError = null;
       });

      // Refresh lock/value overlays for the fact keys we just loaded.
      await _refreshReceiptsForFactKeys(
        rows.map((r) => ((r['fact_key_canonical'] ?? '') as String?)?.trim().isNotEmpty == true
            ? (r['fact_key_canonical'] as String).trim()
            : (r['fact_key_guess'] ?? '').toString().trim()).where((k) => k.isNotEmpty).toList(),
      );
     } catch (e) {
       if (!mounted) return;
       setState(() {
         _factsError = 'Failed to load extracted facts: $e';
       });
    } finally {
      if (!mounted) return;
      setState(() {
        _loadingFactCandidates = false;
      });
    }
  }

  Future<void> _refreshReceiptsForFactKeys(List<String> keys) async {
    final uid = _client.auth.currentUser?.id;
    if (uid == null || uid.isEmpty) return;
    if (keys.isEmpty) return;

    // Supabase has practical limits on IN lists; keep it reasonable.
    final unique = keys.toSet().toList();
    if (unique.isEmpty) return;

    try {
      final res = await _client
          .from('user_facts_receipts')
          .select('fact_key,is_locked,value_json')
          .eq('user_id', uid)
          .inFilter('fact_key', unique);

      final rows = (res is List)
          ? res.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList()
          : <Map<String, dynamic>>[];

      if (!mounted) return;
      setState(() {
        for (final r in rows) {
          final k = (r['fact_key'] ?? '').toString().trim();
          if (k.isEmpty) continue;
          _lockByFactKey[k] = (r['is_locked'] == true);
          // Keep the canonical value so edits/locks reflect instantly in UI.
          if (r.containsKey('value_json')) {
            _valueByFactKey[k] = r['value_json'];
          }
        }
      });
    } catch (_) {
      // Non-fatal: UI can still render candidates; lock overlay just won’t show.
    }
  }

  void _stopFactsPipeline() {
    _factsSub?.cancel();
    _factsSub = null;
    _factsPollTimer?.cancel();
    _factsPollTimer = null;
  }

void _startFactsRealtime(String conversationId) {
  _factsSub?.cancel();
  _factsSub = null;

  final uid = _client.auth.currentUser?.id;
  if (uid == null || uid.isEmpty) return;

  _factsSub = _client
      .from('fact_candidates')
      .stream(primaryKey: ['id'])
      .listen((rows) {
        if (!mounted) return;

        final filtered = rows
            .where((row) =>
                row['user_id'] == uid &&
                row['conversation_id'] == conversationId &&
                ['captured', 'active', 'conflict']
                    .contains(row['status']))
            .map((m) => Map<String, dynamic>.from(m))
            .toList();

        setState(() {
          _factCandidates = filtered;
        });

        // When candidates change, refresh receipt overlays too (lock/value).
        final keys = filtered.map((r) {
          final canonical = (r['fact_key_canonical'] ?? '').toString().trim();
          final guess = (r['fact_key_guess'] ?? '').toString().trim();
          final factKey = canonical.isNotEmpty ? canonical : guess;
          return factKey.trim();
        }).where((k) => k.isNotEmpty).toList();
        _refreshReceiptsForFactKeys(keys);
      });
}

  void _startFactsPollingFallback() {
    _factsPollTimer?.cancel();
    _factsPollTimer = null;

    int ticks = 0;
    _factsPollTimer = Timer.periodic(const Duration(seconds: 2), (t) async {
      ticks++;
      await _fetchFactCandidates(silent: true);
      if (!mounted) {
        t.cancel();
        return;
      }
      if (_factCandidates.isNotEmpty || ticks >= 8) {
        t.cancel();
      }
    });
  }

  void _initFactsPipeline() {
    final convId = _effectiveConversationId();
    if (convId.isEmpty) return;

    _fetchFactCandidates();
    _startFactsRealtime(convId);
    _startFactsPollingFallback();
  }

   // Story recall rows associated with this session (lock/unlock + edits).
   bool _loadingStoryRecall = false;
   List<Map<String, dynamic>> _storyRecallRows = const <Map<String, dynamic>>[];
   bool _didMutate = false;

  String get whatCapturedText {
    final ins = _effectiveInsights();
    final short = pickSummaryFromSessionInsights(ins, full: false).trim();
    final full = pickSummaryFromSessionInsights(ins, full: true).trim();

    final candidate = short.isNotEmpty ? short : full;
    if (candidate.isEmpty) return '—';

    // UI normalization only (do NOT compute alternative truth).
    return _secondPersonifySummary(normalizeSummaryVoice(candidate));
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

  Future<void> _rebuildFromEdits() async {
    final user = _client.auth.currentUser;
    if (user == null) {
      _showSnack('You must be logged in.');
      return;
    }

    final convId = _effectiveConversationId();
    if (convId.isEmpty) {
      _showSnack('Missing conversation id for this session.');
      return;
    }

    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      await _client.functions.invoke(
        'ai-brain',
        body: {
          'op': 'rebuild_conversation_artifacts',
          'conversation_id': convId,
          'end_session': true,
          'message_text': '__END_SESSION__',
        },
      );

      if (!mounted) return;
      _showSnack('Rebuild requested.');
      _didMutate = true;
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Failed to rebuild session summary: $e';
      });
    } finally {
      if (!mounted) return;
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
      final base = <String, dynamic>{..._effectiveInsights()};
      // Preserve Session Review v1 fields if present (avoid clobbering backend).
      final mergedSI = <String, dynamic>{
        ...base,
        // Keep short_summary mirrored for list UIs.
        'short_summary': shortCandidate,
        // Store curated text in session_insights for easy downstream access.
        'curated_story': trimmed,
        'curated_at': DateTime.now().toUtc().toIso8601String(),
        // Explicitly re-preserve if base contains them.
        if (base.containsKey('common_thread')) 'common_thread': base['common_thread'],
        if (base.containsKey('memory_candidates')) 'memory_candidates': base['memory_candidates'],
        if (base.containsKey('version')) 'version': base['version'],
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

   // ============================================================================
   // FACTS REVIEW (End-of-session): display + edit + lock persisted user_facts_receipts
   // ============================================================================
 
    List<Map<String, dynamic>> _factsReviewItems() {
     // Phase B (preferred): fact_candidates table scoped to THIS conversation.
      if (_factCandidates.isNotEmpty) {
        return _factCandidates.map((row) {
          final canonical = (row['fact_key_canonical'] ?? '').toString().trim();
          final guess = (row['fact_key_guess'] ?? '').toString().trim();
          final factKey = canonical.isNotEmpty ? canonical : guess;
  
         final locked = _lockByFactKey[factKey] == true;
         final canonicalValue = _valueByFactKey.containsKey(factKey) ? _valueByFactKey[factKey] : row['value_json'];

          return <String, dynamic>{
            'fact_key': factKey,
            'fact_key_guess': guess,
           'value_json': canonicalValue,
            'confidence': row['confidence'],
            'status': (row['status'] ?? '').toString().trim(),
           'is_locked': locked,
            'note': (canonical.isEmpty && guess.isNotEmpty) ? 'Uncanonicalized key (guess)' : '',
          };
        }).toList();
      }

    // Phase A (fallback): facts_review embedded in session_insights.
    // WARNING: This may include non-session-scoped facts depending on server behavior.
    final ins = _effectiveInsights();
    final fr = ins['facts_review'];
    if (fr is Map) {
      final items = fr['items'];
      if (items is List) {
        final out = items.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
        if (out.isNotEmpty) return out;
      }
    }
     return const <Map<String, dynamic>>[];
   }

  String _formatValueJson(dynamic v) {
    if (v == null) return 'null';
    if (v is String) return v;
    try {
      return jsonEncode(v);
    } catch (_) {
      return v.toString();
    }
  }

  dynamic _parseValueJsonFromText(String raw) {
    final t = raw.trim();
    if (t.isEmpty) return '';
    // Try JSON first (object/array/number/bool/null or quoted string).
    try {
      return jsonDecode(t);
    } catch (_) {
      // Fallback: treat as plain string.
      return t;
    }
  }

  Future<void> _persistUserFactEdit({
    required String factKey,
    required dynamic valueJson,
    required bool isLocked,
  }) async {
    final user = _client.auth.currentUser;
    if (user == null) return;

    setState(() {
      _loading = true;
      _error = '';
    });

     try {
      await _client.from('user_facts_receipts').upsert({
        'user_id': user.id,
        'fact_key': factKey,
        'value_json': valueJson,
        'is_locked': isLocked,
        'updated_at': DateTime.now().toIso8601String(),
      }, onConflict: 'user_id,fact_key');

      // Update local overlays so Phase B-backed UI updates immediately.
      _lockByFactKey[factKey] = isLocked;
      _valueByFactKey[factKey] = valueJson;

      // Update local session_insights facts_review so UI reflects immediately.
      final current = _row;
      if (current != null) {
        final si = current['session_insights'];
        if (si is Map) {
          final fr = (si['facts_review'] is Map) ? (si['facts_review'] as Map) : null;
          final items = (fr != null && fr['items'] is List) ? (fr['items'] as List) : null;
          if (items != null) {
            for (var i = 0; i < items.length; i++) {
              final it = items[i];
              if (it is Map && (it['fact_key'] ?? '').toString().trim() == factKey) {
                it['value_json'] = valueJson;
                it['is_locked'] = isLocked;
              }
            }
          }
        }
      }

      setState(() {});
    } catch (e) {
      setState(() {
        _error = 'Failed to save fact edit: $e';
      });
    } finally {
      setState(() {
        _loading = false;
      });
     }
   }
 
  String _friendlyFactStatus(String raw) {
    final s = raw.trim().toLowerCase();
    if (s.isEmpty) return '';
    if (s == 'conflict') return 'Needs review';
    // Hide internal pipeline labels.
    if (s == 'captured' || s == 'active' || s == 'canonicalized' || s == 'promoted') return '';
    return '';
  }

  String _synthesisSentence(String summaryText) {
    final t = summaryText.trim();
    if (t.isEmpty) return '';
    final items = _factsReviewItems();

    bool hasKey(String needle) {
      final n = needle.toLowerCase();
      for (final m in items) {
        final k = (m['fact_key'] ?? '').toString().toLowerCase();
        if (k.contains(n)) return true;
      }
      return false;
    }

    // Bias toward the Legacy mission when we see relevant facts.
    if (hasKey('legacy_app') || t.toLowerCase().contains('legacy app')) {
      if (hasKey('ordinary_people') || t.toLowerCase().contains('ordinary people')) {
        return 'This session reinforces your mission to preserve ordinary lives and help future generations stay connected to loved ones.';
      }
      return 'This session reinforces your mission to preserve stories and pass forward your values through a digital legacy.';
    }

    // Fallback: distill the first sentence into a single takeaway.
    final idx = t.indexOf(RegExp(r'[.!?]'));
    final first = (idx >= 0) ? t.substring(0, idx + 1).trim() : t;
    if (first.isEmpty) return '';
    return 'Takeaway: $first';
  }

  Future<void> _lockAllFacts() async {
    final user = _client.auth.currentUser;
    if (user == null) return;

     final items = _factsReviewItems();
     final now = DateTime.now().toIso8601String();
 
    // De-dupe by fact_key so a single batch upsert does not include duplicate
    // constrained values (user_id,fact_key), which Postgres rejects (code 21000).
    final byKey = <String, Map<String, dynamic>>{};
     for (final m in items) {
       final key = (m['fact_key'] ?? '').toString().trim();
       if (key.isEmpty) continue;
 
       final status = (m['status'] ?? '').toString().trim().toLowerCase();
       // Don't auto-lock items that still need review.
       if (status == 'conflict') continue;
 
       final valueJson = _valueByFactKey.containsKey(key)
           ? _valueByFactKey[key]
           : (m.containsKey('value_json') ? m['value_json'] : null);
 
      // Last write wins for duplicates (same fact_key).
      byKey[key] = {
         'user_id': user.id,
         'fact_key': key,
         'value_json': valueJson,
         'is_locked': true,
         'updated_at': now,
      };
     }
 
    final rows = byKey.values.toList();
     if (rows.isEmpty) {
       _showSnack('Nothing to lock.');
       return;
     }

    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      await _client.from('user_facts_receipts').upsert(rows, onConflict: 'user_id,fact_key');

      if (!mounted) return;
      setState(() {
        for (final r in rows) {
          final k = (r['fact_key'] ?? '').toString();
          _lockByFactKey[k] = true;
          _valueByFactKey[k] = r['value_json'];
        }
      });

      // Best-effort refresh session candidates so UI reflects "locked" state immediately.
      await _fetchFactCandidates(silent: true);

      if (!mounted) return;
      _showSnack('Locked ${rows.length} facts.');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Failed to lock facts: $e';
      });
    } finally {
      if (!mounted) return;
      setState(() {
        _loading = false;
      });
    }
  }

   Future<void> _editFactDialog(Map<String, dynamic> item) async {
     final factKey = (item['fact_key'] ?? '').toString().trim();
     if (factKey.isEmpty) return;

    final currentValue = item.containsKey('value_json') ? item['value_json'] : null;
    final controller = TextEditingController(text: _formatValueJson(currentValue));
    bool lock = (item['is_locked'] == true);

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Edit fact'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(factKey, style: Theme.of(ctx).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 10),
              TextField(
                controller: controller,
                minLines: 1,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: 'Value (JSON or plain text)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Checkbox(
                    value: lock,
                    onChanged: (v) {
                      lock = (v == true);
                      // Force rebuild of dialog.
                      (ctx as Element).markNeedsBuild();
                    },
                  ),
                  const Expanded(child: Text('Lock this fact (prevents future overwrites)')),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
          ],
        );
      },
    );

    if (ok != true) return;
    final parsed = _parseValueJsonFromText(controller.text);
    await _persistUserFactEdit(factKey: factKey, valueJson: parsed, isLocked: lock);
  }

   Widget _buildFactsReviewSection(BuildContext context) {
     final theme = Theme.of(context);
     final items = _factsReviewItems();
 
    bool _isBoilerplateKey(String k) {
      final key = k.toLowerCase();
      // Adjust this list as your canonical keys stabilize.
      const blockedPrefixes = <String>[
        'user.', 'profile.', 'personal.', 'identity.',
        'name', 'full_name', 'first_name', 'last_name',
        'age', 'birthday', 'birth_date',
        'gender',
        'location', 'country', 'city', 'timezone',
        'language', 'preferred_locale', 'target_locale',
        'job', 'employer', 'education',
        'marital', 'relationship_status',
      ];
      for (final p in blockedPrefixes) {
        if (key == p || key.startsWith('$p.') || key.contains(p)) return true;
      }
      return false;
    }

    double _signalScore(Map<String, dynamic> m) {
      final conf = (m['confidence'] is num) ? (m['confidence'] as num).toDouble() : 0.0;
      final locked = (m['is_locked'] == true);
      final status = (m['status'] ?? '').toString().trim().toLowerCase();
      final key = (m['fact_key'] ?? '').toString().trim();

      // Start with confidence.
      double s = conf;

      // Prefer "this session produced something meaningful" (captured/active).
      if (status == 'conflict') s -= 0.25;
      if (status == 'captured' || status == 'active') s += 0.10;

      // Locked facts are not "attention proof"—they’re already curated.
      if (locked) s -= 0.35;

      // Profile boilerplate doesn’t prove attention; it proves identity memory.
      if (_isBoilerplateKey(key)) s -= 0.60;

      return s;
    }

    // De-dupe by coarse key prefix to avoid showing 4 variants of the same thing.
    String _bucketKey(String k) {
      final key = k.toLowerCase();
      final dot = key.indexOf('.');
      if (dot > 0) return key.substring(0, dot);
      return key;
    }

     // Defensive UI: do not present conflict candidates as "extracted facts".
    final keptItemsAll = items.where((m) {
       final s = (m['status'] ?? '').toString().trim().toLowerCase();
       return s != 'conflict';
     }).toList();
     final conflictItems = items.where((m) {
       final s = (m['status'] ?? '').toString().trim().toLowerCase();
       return s == 'conflict';
     }).toList();
 
    // Compute "signal" set: highest score first, then bucket-dedupe.
    final scored = [...keptItemsAll];
    scored.sort((a, b) => _signalScore(b).compareTo(_signalScore(a)));

    final seenBuckets = <String>{};
    final signal = <Map<String, dynamic>>[];
    for (final m in scored) {
      final key = (m['fact_key'] ?? '').toString().trim();
      if (key.isEmpty) continue;
      final bucket = _bucketKey(key);
      if (seenBuckets.contains(bucket)) continue;
      // Skip truly low-signal items.
      if (_signalScore(m) < 0.20) continue;
      seenBuckets.add(bucket);
      signal.add(m);
      if (signal.length >= _factsPreviewLimit) break;
    }

    final keptItems = _showAllFacts ? keptItemsAll : signal;
 
     return Column(
       crossAxisAlignment: CrossAxisAlignment.start,
       children: [
         Text('Facts extracted', style: theme.textTheme.titleSmall),
         const SizedBox(height: 6),
         Text(
          'A few highlights that show the app was paying attention. You can edit and lock anything important.',
           style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54),
         ),
         const SizedBox(height: 10),
        if (_factsError != null && _factsError!.trim().isNotEmpty) ...[
          Text(_factsError!, style: theme.textTheme.bodySmall?.copyWith(color: Colors.red)),
          const SizedBox(height: 10),
        ],
        if (_loadingFactCandidates && keptItems.isEmpty && conflictItems.isEmpty) ...[
          Row(
            children: [
              const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
              const SizedBox(width: 10),
              Expanded(child: Text('Extracting facts…', style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54))),
            ],
          ),
          const SizedBox(height: 10),
        ],
         if (keptItems.isEmpty)
           const Text(
             'No new long-term facts were extracted from this session. (That can be normal when the conversation is mostly reflective or exploratory.)',
           )
         else
         if (keptItemsAll.length > _factsPreviewLimit) ...[
           Row(
             children: [
               TextButton(
                 onPressed: () {
                   setState(() {
                     _showAllFacts = !_showAllFacts;
                   });
                 },
                 child: Text(
                   _showAllFacts ? 'Show fewer highlights' : 'Show all (${keptItemsAll.length})',
                 ),
               ),
               const Spacer(),
               OutlinedButton.icon(
                 onPressed: _loading ? null : () => _lockAllFacts(),
                 icon: const Icon(Icons.lock, size: 18),
                 label: const Text('Lock all'),
               ),
             ],
           ),
             const SizedBox(height: 6),
           ],
           ...keptItems.map((m) {
             final key = (m['fact_key'] ?? '').toString().trim();
             final v = m.containsKey('value_json') ? m['value_json'] : null;
             final locked = (m['is_locked'] == true);
             final statusRaw = (m['status'] ?? '').toString().trim();
             final status = _friendlyFactStatus(statusRaw);
             final note = (m['note'] ?? '').toString().trim();
 
             return Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.black12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          key.isEmpty ? '(missing fact_key)' : key,
                          style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      if (locked)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: Colors.black12,
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text('Locked', style: theme.textTheme.bodySmall),
                        ),
                    ],
                   ),
                   const SizedBox(height: 6),
                   Text(_formatValueJson(v), style: theme.textTheme.bodySmall),
                   const SizedBox(height: 6),
                  if (status.isNotEmpty) ...[
                    Text(status, style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54)),
                    const SizedBox(height: 6),
                  ],
                   if (note.isNotEmpty) ...[
                     const SizedBox(height: 4),
                     Text(note, style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54)),
                   ],
                   const SizedBox(height: 8),
                  Wrap(
                    spacing: 10,
                    runSpacing: 8,
                    children: [
                      OutlinedButton.icon(
                        onPressed: _loading ? null : () => _editFactDialog(m),
                        icon: const Icon(Icons.edit, size: 18),
                        label: const Text('Edit'),
                      ),
                      OutlinedButton.icon(
                        onPressed: _loading
                            ? null
                            : () => _persistUserFactEdit(
                                  factKey: key,
                                  valueJson: v,
                                  isLocked: !locked,
                                ),
                        icon: const Icon(Icons.lock, size: 18),
                        label: Text(locked ? 'Unlock' : 'Lock'),
                      ),
                    ],
                  ),
                ],
              ),
            );
          }),

        if (conflictItems.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Conflicts detected', style: theme.textTheme.titleSmall),
          const SizedBox(height: 6),
          Text(
            'These items conflicted with an existing saved fact, so they were NOT accepted.',
            style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54),
          ),
          const SizedBox(height: 10),
           ...conflictItems.map((m) {
            final key = (m['fact_key'] ?? m['fact_key_guess'] ?? '').toString().trim();
            final v = m.containsKey('value_json') ? m['value_json'] : null;
            final status = (m['status'] ?? '').toString().trim();
            final note = (m['note'] ?? '').toString().trim();

            return Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.black12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    key.isEmpty ? '(missing fact_key)' : key,
                    style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 6),
                  Text(_formatValueJson(v), style: theme.textTheme.bodySmall),
                  const SizedBox(height: 6),
                  if (status.isNotEmpty)
                    Text(status, style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54)),
                  if (note.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(note, style: theme.textTheme.bodySmall?.copyWith(color: Colors.black54)),
                  ],
                ],
              ),
            );
          }),
        ],
      ],
    );
  }

  bool _loading = false;
  String _error = '';

  Map<String, dynamic>? _row; // memory_summary row

  @override
  void initState() {
    super.initState();
    _load().whenComplete(() {
      if (!mounted) return;
      _initFactsPipeline();
    });
   }
 
  @override
  void dispose() {
    _stopFactsPipeline();
    super.dispose();
  }

  String _effectiveConversationId() {
    final fromDb = (_row?['conversation_id'] ?? '').toString().trim();
    if (fromDb.isNotEmpty) return fromDb;
    return widget.sessionKey.trim();
  }

  Future<void> _loadStoryRecallForSession() async {
    final uid = _client.auth.currentUser?.id;
    if (uid == null || uid.isEmpty) return;
    final convId = _effectiveConversationId();
    if (convId.isEmpty) return;

    setState(() {
      _loadingStoryRecall = true;
    });

    try {
      final res = await _client
          .from('story_recall')
          .select('id, title, synopsis, story_seed_id, updated_at, is_locked, conversation_id')
          .eq('user_id', uid)
          .eq('conversation_id', convId)
          .order('updated_at', ascending: false);

      final rows = (res is List)
          ? res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : <Map<String, dynamic>>[];

      if (!mounted) return;
      setState(() {
        _storyRecallRows = rows;
      });
    } catch (e) {
      // Non-fatal: the screen should still work even if story_recall isn't available.
      if (!mounted) return;
      setState(() {
        _error = (_error.isNotEmpty ? '$_error\n' : '') + 'Failed to load session stories: $e';
      });
    } finally {
      if (!mounted) return;
      setState(() {
        _loadingStoryRecall = false;
      });
    }
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _toggleStoryRecallLock(String id, bool isLocked) async {
    final uid = _client.auth.currentUser?.id;
    if (uid == null || uid.isEmpty) return;
    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      await _client
          .from('story_recall')
          .update({'is_locked': !isLocked, 'updated_at': DateTime.now().toUtc().toIso8601String()})
          .eq('id', id)
          .eq('user_id', uid);

      // Refresh local list.
      await _loadStoryRecallForSession();
    } catch (e) {
      setState(() {
        _error = 'Failed to update story lock: $e';
      });
    } finally {
      if (!mounted) return;
      setState(() {
        _loading = false;
      });
    }
  }

  Future<void> _editStoryRecallTitle(Map<String, dynamic> row) async {
    final uid = _client.auth.currentUser?.id;
    if (uid == null || uid.isEmpty) return;

    final id = (row['id'] ?? '').toString().trim();
    if (id.isEmpty) return;
    final locked = (row['is_locked'] == true);
    if (locked) {
      _showSnack('This story is locked. Unlock it to edit the title.');
      return;
    }

    final current = (row['title'] ?? '').toString();
    final controller = TextEditingController(text: current);

    final nextTitle = await showDialog<String>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Rename story'),
          content: TextField(
            controller: controller,
            decoration: const InputDecoration(
              labelText: 'Title',
              border: OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, null), child: const Text('Cancel')),
            ElevatedButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('Rename')),
          ],
        );
      },
    );

    final trimmed = (nextTitle ?? '').trim();
    if (trimmed.isEmpty || trimmed == current.trim()) return;

    setState(() {
      _loading = true;
      _error = '';
    });

    try {
      await _client
          .from('story_recall')
          .update({'title': trimmed, 'updated_at': DateTime.now().toUtc().toIso8601String()})
          .eq('id', id)
          .eq('user_id', uid);
      await _loadStoryRecallForSession();
    } catch (e) {
      setState(() {
        _error = 'Failed to update story title: $e';
      });
    } finally {
      if (!mounted) return;
      setState(() {
        _loading = false;
      });
    }
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

        // --- Critical fix for rebuild-from-edits ---
        // If memory_summary.conversation_id is missing, fall back to memory_raw.conversation_id via raw_id.
        // Otherwise, callers will (incorrectly) use the memory_summary UUID as the conversation_id,
        // which causes rebuild-summaries-v2 to summarize the wrong session and keep placeholders.
        final existingConv = (_row?['conversation_id'] ?? '').toString().trim();
        final rawId = (_row?['raw_id'] ?? '').toString().trim();
        final uid = _client.auth.currentUser?.id ?? '';
        if (existingConv.isEmpty && rawId.isNotEmpty && uid.isNotEmpty) {
          try {
            final rawRes = await _client
                .from('memory_raw')
                .select('conversation_id')
                .eq('user_id', uid)
                .eq('id', rawId)
                .maybeSingle();

            final rawMap = rawRes as Map<String, dynamic>?;
            final conv = (rawMap?['conversation_id'] ?? '').toString().trim();

            if (conv.isNotEmpty) {
              _row = { ...?_row, 'conversation_id': conv };
              // Best-effort persist so future loads/rebuilds are stable.
              try {
                await _client
                    .from('memory_summary')
                    .update({'conversation_id': conv})
                    .eq('id', id);
              } catch (_) {}
            }
          } catch (_) {}
        }

        // Load story_recall rows for this session (lock/unlock + quick edits).
        // (BURNED DOWN) Session stories are no longer loaded for end-session review.
       } else {
         _error = 'Session summary not found yet.';
       }
    } catch (e) {
      _error = 'Failed to load session review: $e';
     } finally {
       if (!mounted) return;
       setState(() {
        _loading = false;
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
    // Supabase can return json/jsonb as String; parse it if so.
    final parsed = parseJsonMap(fromDb);
    if (parsed != null) return parsed;
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
     final shortSummary = _effectiveShortSummary();
     final fullSummary = _effectiveFullSummary();
  
    final String summaryText = (shortSummary.trim().isNotEmpty)
        ? shortSummary
        : (fullSummary.trim().isNotEmpty)
            ? fullSummary
            : '';
  
     return WillPopScope(
       onWillPop: () async {
         Navigator.of(context).pop(_didMutate);
         return false;
       },
       child: Scaffold(
         appBar: AppBar(
           title: const Text('End of session'),
           actions: [
             IconButton(
               tooltip: 'Refresh',
               icon: const Icon(Icons.refresh),
               onPressed: _loading ? null : _load,
             ),
              IconButton(
                tooltip: 'Rebuild summary',
                icon: const Icon(Icons.auto_fix_high),
                onPressed: _loading ? null : _rebuildFromEdits,
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
 
                  // Clean, fast-to-scan summary (reframed/short/full; whichever exists)
                  Text('Session summary', style: Theme.of(context).textTheme.titleSmall),
                   const SizedBox(height: 8),
                   Container(
                     padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        border: Border.all(color: Colors.black12),
                        borderRadius: BorderRadius.circular(8),
                      ),
                    child: Text(summaryText),
                  ),
                 const SizedBox(height: 10),
                 if (_synthesisSentence(summaryText).isNotEmpty)
                   Text(
                     _synthesisSentence(summaryText),
                     style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.black54),
                   ),
                 const SizedBox(height: 16),
 
                   _buildFactsReviewSection(context),
                ],
              ),
          ),
      ),
    );
  }
}