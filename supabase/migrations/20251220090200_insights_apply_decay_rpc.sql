CREATE OR REPLACE FUNCTION public.apply_insight_decay(
  p_user_id uuid,
  p_now timestamptz DEFAULT now(),
  p_emerging_cool_days integer DEFAULT 14,
  p_active_cool_days integer DEFAULT 45,
  p_archive_days integer DEFAULT 120,
  p_daily_decay double precision DEFAULT 0.01,
  p_archive_below double precision DEFAULT 0.20
)
RETURNS TABLE(updated_count integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer := 0;
  v_rows integer := 0;
BEGIN
  -- 1) Move emerging -> cooling if stale
  UPDATE public.memory_insights
  SET status = 'cooling'
  WHERE user_id = p_user_id
    AND status = 'emerging'
    AND COALESCE(last_reinforced_at, first_detected_at)
        < (p_now - (p_emerging_cool_days || ' days')::interval);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_updated := v_updated + v_rows;

  -- 2) Move active -> cooling if stale
  UPDATE public.memory_insights
  SET status = 'cooling'
  WHERE user_id = p_user_id
    AND status = 'active'
    AND COALESCE(last_reinforced_at, first_detected_at)
        < (p_now - (p_active_cool_days || ' days')::interval);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_updated := v_updated + v_rows;

  -- 3) Apply daily decay to cooling insights
  UPDATE public.memory_insights
  SET confidence_score = GREATEST(
        0.0,
        confidence_score - (
          p_daily_decay * GREATEST(
            0,
            EXTRACT(day FROM (p_now - COALESCE(last_reinforced_at, first_detected_at)))
          )
        )
      )
  WHERE user_id = p_user_id
    AND status = 'cooling';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_updated := v_updated + v_rows;

  -- 4) Archive if very stale OR too low confidence
  UPDATE public.memory_insights
  SET status = 'archived',
      archived_at = p_now
  WHERE user_id = p_user_id
    AND status IN ('cooling','emerging','active')
    AND (
      confidence_score < p_archive_below
      OR COALESCE(last_reinforced_at, first_detected_at)
          < (p_now - (p_archive_days || ' days')::interval)
    );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_updated := v_updated + v_rows;

  RETURN QUERY SELECT v_updated;
END;
$$;
