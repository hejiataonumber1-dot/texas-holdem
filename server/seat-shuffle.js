const crypto=require('node:crypto');

class SeatShuffleVote {
  constructor({sessions,onChange=()=>{},timeoutMs=60000,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,createId=crypto.randomUUID}) {
    Object.assign(this,{sessions,onChange,timeoutMs,now,setTimer,clearTimer,createId});
  }
  participants(room) {return room.game.players.filter(p=>p.seated!==false&&!p.pendingRemove);}
  online(room,id) {const session=this.sessions.get(id);return session?.room===room.code&&session.ws?.readyState===1;}
  clear(room,message) {
    this.clearTimer(room.seatVoteTimer);room.seatVoteTimer=null;
    if(!room.seatVote)return false;
    room.seatVote=null;room.updated=this.now();
    if(message)room.game.log(message);
    return true;
  }
  validate(room) {
    const vote=room.seatVote;if(!vote)return false;
    let reason='';
    if(this.now()>=vote.expiresAt)reason='等待同意超时';
    else if(room.finished)reason='牌桌已结束';
    else if(room.ownerId!==vote.initiatorId)reason='房主已变更';
    else if(room.game.playing())reason='牌局已开始';
    else {
      const ids=this.participants(room).map(p=>p.id);
      if(ids.length!==vote.participantIds.length||ids.some(id=>!vote.participantIds.includes(id)))reason='在座玩家发生变化';
      else if(vote.participantIds.some(id=>!this.online(room,id)))reason='有参与玩家掉线';
    }
    return reason?this.clear(room,`随机换位已取消：${reason}`):false;
  }
  current(room,voteId) {
    if(this.validate(room))this.onChange(room);
    if(!room.seatVote||typeof voteId!=='string'||room.seatVote.id!==voteId)throw Error('换位投票已结束或更新，请重新查看');
    return room.seatVote;
  }
  request(room,id) {
    if(room.ownerId!==id)throw Error('只有房主可以发起随机换位');
    if(room.finished)throw Error('牌桌已结束，不能随机换位');
    if(room.game.playing())throw Error('本局结束后才能随机换位');
    if(this.validate(room))this.onChange(room);
    if(room.seatVote)throw Error('已有换位投票，请等待结果或取消');
    const players=this.participants(room);
    if(players.length<2)throw Error('至少需要两位在座玩家才能随机换位');
    if(players.some(p=>!this.online(room,p.id)))throw Error('所有在座玩家在线后才能发起随机换位');
    const participantIds=players.map(p=>p.id),vote={id:this.createId(),initiatorId:id,participantIds,approvedIds:participantIds.includes(id)?[id]:[],expiresAt:this.now()+this.timeoutMs};
    room.seatVote=vote;room.updated=this.now();
    const name=room.game.players.find(p=>p.id===id)?.name||'房主';
    room.game.log(`${name} 发起随机换位，等待所有在座玩家同意`);
    room.seatVoteTimer=this.setTimer(()=>{
      if(room.seatVote?.id!==vote.id)return;
      this.clear(room,'随机换位已取消：等待同意超时');this.onChange(room);
    },this.timeoutMs);
    room.seatVoteTimer?.unref?.();
    return vote;
  }
  vote(room,id,voteId,agree) {
    const vote=this.current(room,voteId);
    if(!vote.participantIds.includes(id))throw Error('只有本次投票的在座玩家可以选择');
    if(typeof agree!=='boolean')throw Error('请选择同意或拒绝换位');
    const name=room.game.players.find(p=>p.id===id)?.name||'玩家';
    if(!agree){this.clear(room,`随机换位已取消：${name} 拒绝换位`);return;}
    if(vote.approvedIds.includes(id))return;
    vote.approvedIds.push(id);room.updated=this.now();
    if(vote.participantIds.every(playerId=>vote.approvedIds.includes(playerId))){room.game.shuffleSeats();this.clear(room);}
    else room.game.log(`${name} 同意随机换位（${vote.approvedIds.length}/${vote.participantIds.length}）`);
  }
  cancel(room,id,voteId) {
    if(room.ownerId!==id)throw Error('只有房主可以取消换位投票');
    this.current(room,voteId);this.clear(room,'随机换位已取消：房主取消了投票');
  }
}

module.exports={SeatShuffleVote};
