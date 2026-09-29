// Runs every 6 days to prevent Supabase free tier from pausing the project.
const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false } }
    );
    // Lightweight query — just counts projects, touches no user data
    const { error } = await supabase.from('review_projects').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    console.log('Supabase keepalive OK');
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Supabase keepalive failed:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
