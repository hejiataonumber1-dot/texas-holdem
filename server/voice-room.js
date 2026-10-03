const crypto=require('node:crypto');
class VoiceRooms {
  constructor({send,sessions,iceServers,transport='webrtc'}){this.send=send;this.sessions=sessions;this.iceServers=iceServers;this.transport=transport;}
  members(room){return [...(room.voice?.values()||[])];}
  roster(room){const data={type:'voice-roster',peers:this.members(room)};for(const p of room.game.players)if(!p.pendingRemove)this.send(this.sessions.get(p.id)?.ws,data);}
  join(room,session){
    room.voice??=new Map();if(room.voice.has(session.id))throw Error('你已加入语音');
    if(room.voice.size>=9)throw Error('语音已满，最多 9 人同时连麦');
    room.voice.set(session.id,{id:session.id,peerId:crypto.randomUUID(),name:session.name,muted:true});
    this.send(session.ws,{type:'voice-joined',peers:this.members(room),iceServers:this.iceServers,transport:this.transport});this.roster(room);
  }
  leave(room,session){if(room?.voice?.delete(session.id))this.roster(room);}
  mute(room,session,muted){const me=room.voice?.get(session.id);if(!me)throw Error('请先加入语音');if(typeof muted!=='boolean')throw Error('静音状态无效');me.muted=muted;this.roster(room);}
  audio(room,session,data){
    const me=room.voice?.get(session.id);if(!me)throw Error('请先加入语音');if(me.muted)return;
    if(typeof data!=='string'||data.length!==2560||!/^[A-Za-z0-9+/]+$/.test(data))throw Error('语音音频格式无效');
    for(const peer of this.members(room)){if(peer.id===session.id)continue;const ws=this.sessions.get(peer.id)?.ws;if(ws&&ws.bufferedAmount<65536)this.send(ws,{type:'voice-audio',from:me.peerId,data});}
  }
  signal(room,session,to,data){
    const me=room.voice?.get(session.id),peer=this.members(room).find(p=>p.peerId===to);
    if(!me||!peer||peer.id===session.id)throw Error('语音成员不存在或已退出');
    let safe;
    if(data?.kind==='description'&&['offer','answer'].includes(data.description?.type)&&typeof data.description.sdp==='string'&&data.description.sdp.length<=12000){safe={kind:'description',description:{type:data.description.type,sdp:data.description.sdp}};}
    else if(data?.kind==='candidate'&&typeof data.candidate?.candidate==='string'&&data.candidate.candidate.length<=2048&&(data.candidate.sdpMid==null||(typeof data.candidate.sdpMid==='string'&&data.candidate.sdpMid.length<=64))&&(data.candidate.sdpMLineIndex==null||(Number.isInteger(data.candidate.sdpMLineIndex)&&data.candidate.sdpMLineIndex>=0&&data.candidate.sdpMLineIndex<=16))){safe={kind:'candidate',candidate:{candidate:data.candidate.candidate,sdpMid:data.candidate.sdpMid??null,sdpMLineIndex:data.candidate.sdpMLineIndex??null}};}
    else throw Error('语音连接信息无效');
    const target=this.sessions.get(peer.id);if(!target?.ws)throw Error('对方已断线');this.send(target.ws,{type:'voice-signal',from:me.peerId,data:safe});
  }
}
module.exports={VoiceRooms};
