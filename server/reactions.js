const {randomUUID}=require('node:crypto');
const {WebSocket}=require('ws');

const REACTIONS=new Set(['laugh','like','clap','handshake','cool','think','cry','party']);
const REACTION_COOLDOWN_MS=2000;

class RoomReactions {
  constructor({sessions,send,clock=Date.now}){this.sessions=sessions;this.send=send;this.clock=clock;}
  member(room,id,now){
    const player=room?.game.players.find(p=>p.id===id&&!p.pendingRemove),session=this.sessions.get(id);
    return player&&session?.room===room.code&&session.expiresAt>now&&session.ws?.readyState===WebSocket.OPEN?{player,session}:null;
  }
  react(room,session,message){
    const now=this.clock();
    if(!room)throw Error('请先创建或加入房间');
    const from=this.member(room,session.id,now);
    if(!from||from.session!==session)throw Error('你已不在这个房间，请重新加入');
    if(typeof message.emoji!=='string'||!REACTIONS.has(message.emoji))throw Error('请选择支持的表情');
    if(typeof message.to!=='string'||!message.to)throw Error('请选择接收表情的玩家');
    if(message.to===session.id)throw Error('请选择其他玩家');
    const target=this.member(room,message.to,now);
    if(!target)throw Error('这位玩家已离线或离开房间');
    if(session.reactionReadyAt>now){
      const error=Error('表情发送太快，请稍候');error.retryAfterMs=session.reactionReadyAt-now;throw error;
    }
    const event={type:'reaction',id:randomUUID(),room:room.code,from:session.id,to:target.player.id,emoji:message.emoji,fromName:from.player.name,toName:target.player.name};
    session.reactionReadyAt=now+REACTION_COOLDOWN_MS;room.updated=now;
    for(const player of room.game.players){const recipient=this.member(room,player.id,now);if(recipient)this.send(recipient.session.ws,event);}
    return event;
  }
}

module.exports={RoomReactions,REACTIONS,REACTION_COOLDOWN_MS};
