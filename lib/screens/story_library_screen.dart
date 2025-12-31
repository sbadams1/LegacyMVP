import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class StoryLibraryScreen extends StatefulWidget {
  const StoryLibraryScreen({super.key});

  @override
  State<StoryLibraryScreen> createState() => _StoryLibraryScreenState();
}

class _StoryLibraryScreenState extends State<StoryLibraryScreen> {
  final SupabaseClient _client = Supabase.instance.client;

  bool _loading = true;
  String? _error;

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
    final obs = _asJsonMap(row['observations']);
    final marker = (obs?['summary_level'] ??
            obs?['level'] ??
            obs?['kind'] ??
            obs?['type'] ??
            '')
        .toString()
        .toLowerCase()
        .trim();

    if (marker.contains('session')) return true;
    if (marker.contains('turn') || marker.contains('message')) return false;

    final si = _asJsonMap(row['session_insights']);
    final keySentence = (si?['key_sentence'] as String? ?? '').trim();
    final items = (si?['items'] as List<dynamic>? ?? const []);
    if (keySentence.isNotEmpty || items.isNotEmpty) return true;

    final shortSummary = (row['short_summary'] as String? ?? '').trim();
    final fullSummary = (row['full_summary'] as String? ?? '').trim();
    final merged = shortSummary.isNotEmpty ? shortSummary : fullSummary;

    // Exclude language-learning tagged outputs if they ever land in memory_summary
    final lower = merged.toLowerCase();
    if (lower.contains('[l1]') || lower.contains('[l2]') || lower.contains('[lesson]') ||
        lower.contains('[vocab]') || lower.contains('[drill]') || lower.contains('[quiz]') ||
        lower.contains('[rom]')) {
      return false;
    }


    // filter out the "mini transcript" style rows
    if (merged.toLowerCase().startsWith('hey gemini')) return false;
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
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall,
      ),
      onPressed: onTap,
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
              'id, conversation_id, raw_id, short_summary, full_summary, observations, session_insights, created_at')
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

                        final shortSummary =
                            (row['short_summary'] as String? ?? '').trim();
                        final fullSummary =
                            (row['full_summary'] as String? ?? '').trim();

                        final sessionSummary = (shortSummary.isNotEmpty
                            ? shortSummary
                            : (fullSummary.isNotEmpty
                                ? fullSummary
                                : '(No session summary yet)'));

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
                              builder: (_) => StoryDetailScreen(
                                memorySummaryId: memorySummaryId,
                                sessionKey: rawSessionKey.isNotEmpty
                                    ? rawSessionKey
                                    : null,
                                dateLabel: dateLabel,
                                fallbackTitle: dateLabel,
                                fallbackBody: sessionSummary,
                                shortSummary: shortSummary,
                                fullSummary: fullSummary,
                                sessionInsights: sessionInsights,
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
  bool _loading = true;
  bool _saving = false;
  bool _deleting = false;
  // Controls whether "reveal" panels (insights/seeds) are visible in this screen.
  // Default is false to keep donor UX clean.
  bool _revealPanels = false;

  String? _error;

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

  void _kickoffSideLoads() {
    // Story seeds are per-session (conversation_id == observations.session_key).
    final sk = (widget.sessionKey ?? '').trim();
    if (sk.isNotEmpty) {
      _loadStorySeedsForSession(sk);
    }
    // Longitudinal insights are cross-session (latest N for this user).
    _loadLatestLongitudinalInsights();
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
          ...items.take(10).map((it) {
            if (it is! Map) return const SizedBox.shrink();
            final text = (it['text'] as String? ?? '').trim();
            final kind = (it['kind'] as String? ?? '').trim();
            if (text.isEmpty) return const SizedBox.shrink();

            final prefix = kind.isNotEmpty ? '${kind.toUpperCase()}: ' : '';
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text("• $prefix$text"),
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
            .select('short_summary, full_summary')
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
      final fullSummaryFromDb =
          (summaryRes?['full_summary'] as String? ?? '').trim();

      final effectiveShortSummary = shortSummaryFromDb.isNotEmpty
          ? shortSummaryFromDb
          : widget.shortSummary.trim();

      final effectiveFullSummary = fullSummaryFromDb.isNotEmpty
          ? fullSummaryFromDb
          : widget.fullSummary.trim();

      String initialText;
      if (effectiveFullSummary.isNotEmpty) {
        initialText = effectiveFullSummary;
      } else if (effectiveShortSummary.isNotEmpty) {
        initialText = effectiveShortSummary;
      } else {
        // Last resort: whatever fallback we computed earlier.
        initialText = widget.fallbackBody;
      }

      _controller.text = initialText;

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
          .select('id, title, seed_type, seed_json, created_at, conversation_id, summary_id')
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
    // Try a few common fields inside seed_json
    final sj = seed['seed_json'];
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
    final sk = (widget.sessionKey ?? '').trim();
    if (sk.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Stories identified in this session',
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 8),

        if (_loadingSeeds)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_seedError != null)
          Text(
            _seedError!,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.error,
            ),
          )
        else if (_storySeeds.isEmpty)
          Text(
            'No story seeds found yet for this session.',
            style: theme.textTheme.bodyMedium,
          )
        else
          ..._storySeeds.take(10).map((s) {
            final title = ((s['title'] as String?) ?? '').trim();
            final seedType = ((s['seed_type'] as String?) ?? '').trim();
            final oneLiner = _seedOneLiner(s);
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
                            title.isNotEmpty ? title : '(Untitled story)',
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        if (seedType.isNotEmpty)
                          Chip(
                            visualDensity: VisualDensity.compact,
                            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            label: Text(seedType),
                          ),
                      ],
                    ),
                    if (oneLiner.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(oneLiner, style: theme.textTheme.bodyMedium),
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
            'No insights found yet.',
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

      // 2) Update memory_summary.full_summary so downstream systems see curated text
      await _client
          .from('memory_summary')
          .update({'full_summary': trimmed})
          .eq('id', widget.memorySummaryId)
          .eq('user_id', user.id);

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
                        _buildSessionInsightsSection(theme),
                        _buildStorySeedsSection(theme),
                        _buildLongitudinalInsightsSection(theme),
                        Text(
                          'Your story for this session',
                          style: theme.textTheme.titleMedium,
                        ),
                        const SizedBox(height: 8),
                        SizedBox(
                          height: editorH,
                          child: TextField(
                            controller: _controller,
                            maxLines: null,
                            expands: true,
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
                              'No insights yet. As you record more memories, '
                              'this screen will show patterns and themes.',
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
      // First try: use the passed key as memory_raw.conversation_id
      List<dynamic> res = await _client
          .from('memory_raw')
          .select('id, content, source, created_at, conversation_id')
          .eq('user_id', user.id)
          .eq('conversation_id', widget.sessionKey)
          .order('created_at', ascending: true);

      // Fallback: if nothing found and we have a raw_id seed, look up the real conversation_id
      if ((res as List).isEmpty && widget.rawIdSeed != null && widget.rawIdSeed!.isNotEmpty) {
        final seedRes = await _client
            .from('memory_raw')
            .select('conversation_id')
            .eq('user_id', user.id)
            .eq('id', widget.rawIdSeed!)
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
              .order('created_at', ascending: true);
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