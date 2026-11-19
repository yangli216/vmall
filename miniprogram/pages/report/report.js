const app=getApp();
const accountNames={NORMAL_POINT:'普通积分',RED_PACKET:'红包',NORMAL_POINT_DEBT:'普通积分待抵回',RED_PACKET_DEBT:'红包待抵回'};
const eventNames={ORDER_RESERVE:'下单预占',ORDER_RELEASE:'取消/退款返还',ORDER_EARN:'履约赠送',REFERRAL_EARN:'推荐奖励',ADMIN_ADJUST:'掌柜调整',MEMBER_EXIT:'退出会员清零',REFUND_REWARD_REVERSE:'退款奖励冲正',REFUND_REWARD_DEBT:'新增待抵回',REWARD_DEBT_SETTLE:'本次奖励抵回',REFUND_FORFEITED_REWARD:'已清零奖励核对'};
Page({
  data:{date:'',summary:null,summaryLoading:false,summaryError:'',kind:'PAYMENT',rows:[],nextCursor:null,detailLoading:false,detailError:'',checkedAt:''},
  onLoad(){this._alive=true;this.setData({date:new Date(Date.now()+8*3600000).toISOString().slice(0,10)});this.refresh();},
  onUnload(){this._alive=false;this._summarySequence=(this._summarySequence || 0)+1;this._detailSequence=(this._detailSequence || 0)+1;},
  onPullDownRefresh(){this.refresh().finally(()=>wx.stopPullDownRefresh());},
  onReachBottom(){if(this.data.nextCursor && !this.data.detailLoading)this.loadDetails(true);},
  changeDate(e){if(e.detail.value===this.data.date)return;this.setData({date:e.detail.value,summary:null,rows:[],nextCursor:null});this.refresh();},
  changeKind(e){const kind=e.currentTarget.dataset.kind;if(!['PAYMENT','REFUND'].includes(kind) || kind===this.data.kind)return;this.setData({kind,rows:[],nextCursor:null});this.loadDetails();},
  async refresh(){await Promise.all([this.loadSummary(),this.loadDetails()]);},
  async loadSummary(){
    const sequence=this._summarySequence=(this._summarySequence || 0)+1,date=this.data.date;
    this.setData({summaryLoading:true,summaryError:''});
    try{
      const report=await app.api('/api/admin/reports/daily?date='+date);
      if(!this._alive || sequence!==this._summarySequence)return;
      const summary=Object.assign({},report,{benefits:report.benefits.map(row=>Object.assign({},row,{account_title:accountNames[row.account_type] || row.account_type,event_title:eventNames[row.event_type] || row.event_type}))});
      this.setData({summary,checkedAt:new Date().toLocaleTimeString()});
    }catch(error){if(this._alive && sequence===this._summarySequence)this.setData({summaryError:error.message});}
    finally{if(this._alive && sequence===this._summarySequence)this.setData({summaryLoading:false});}
  },
  async loadDetails(append=false){
    if(append && (this.data.detailLoading || !this.data.nextCursor))return;
    const sequence=this._detailSequence=(this._detailSequence || 0)+1,date=this.data.date,kind=this.data.kind;
    this.setData({detailLoading:true,detailError:''});
    try{
      const result=await app.api('/api/admin/reports/transactions?date='+date+'&kind='+kind+(append?'&before_id='+this.data.nextCursor:''));
      if(!this._alive || sequence!==this._detailSequence)return;
      this.setData({rows:(append?this.data.rows:[]).concat(result.list),nextCursor:result.next_cursor});
    }catch(error){if(this._alive && sequence===this._detailSequence)this.setData({detailError:error.message});}
    finally{if(this._alive && sequence===this._detailSequence)this.setData({detailLoading:false});}
  },
  moreDetails(){this.loadDetails(true);},
  retrySummary(){this.loadSummary();},retryDetails(){this.loadDetails();},
  copyOrder(e){wx.setClipboardData({data:e.currentTarget.dataset.sn});}
});
