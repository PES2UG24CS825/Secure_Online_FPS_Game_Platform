const { MongoClient } = require('mongodb');
(async () => {
  const client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  const db = client.db('fps_security_platform');
  const total = await db.collection('users').countDocuments();
  const roles = await db.collection('users').aggregate([
    { $group: { _id: '$role', count: { $sum: 1 } } }
  ]).toArray();
  const admins = await db.collection('users').find({ role: { $in: ['admin', 'super_admin', 'demo_admin'] } }).toArray();
  const realUsers = await db.collection('users').find({
    email: { $not: /(@example\.com|@test\.local|deleted_)/ }
  }).toArray();
  console.log('Total users:', total);
  console.log('Roles:', roles);
  console.log('Admins:', admins.map(a => ({ id: a._id, email: a.email, username: a.username, role: a.role })));
  console.log('Real non-test users:', realUsers.map(u => ({ id: u._id, email: u.email, username: u.username, role: u.role, status: u.account_status })));

  const sessionCount = await db.collection('game_sessions').countDocuments();
  const dummySessions = await db.collection('game_sessions').countDocuments({ session_id: /sess_che/ });
  console.log('Total game_sessions:', sessionCount, 'sess_che count:', dummySessions);

  await client.close();
})();
