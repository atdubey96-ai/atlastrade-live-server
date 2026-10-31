import {timingSafeEqual} from 'node:crypto';
export function serviceAuthorized(req, token=process.env.LIVE_SERVICE_TOKEN){
 const expected=Buffer.from(String(token||''));
 const provided=Buffer.from(String(req.headers?.authorization||'').replace(/^Bearer /,''));
 return expected.length>0&&expected.length===provided.length&&timingSafeEqual(expected,provided);
}
export function requireService(req,res,next){
 if(!serviceAuthorized(req))return res.status(401).json({error:'Service authentication required'});
 next();
}
