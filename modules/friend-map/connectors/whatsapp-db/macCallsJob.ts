// The WhatsApp calls job's names (macCalls.ts runs it): its launchd label and its state's folder, here alone so the
// Events page's Sources tab (jobs/sources.ts) names them without loading the job's script.

export const LAUNCHD_LABEL = "local.whatsapp-calls-import";

/** The run's lock and state (state.json: the calls' fingerprint at the last import, and when it last synced well), in the archive's folder. */
export const STATE_FOLDER = "whatsapp-mac-calls";
