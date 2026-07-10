'use strict';
// data.js — curated common-misspelling map (misspelling → correct). High precision: only real,
// unambiguous English typos, so the check never flags a correctly-spelled word. Extend freely; each
// entry is deterministic. This is NOT a full dictionary (which would need a large wordlist + would
// false-positive on names/jargon) — it is a zero-false-positive common-typo linter.
const MISSPELLINGS = {
  accomodate: 'accommodate', acheive: 'achieve', acheived: 'achieved', adress: 'address',
  agressive: 'aggressive', apparant: 'apparent', arguement: 'argument', assistanse: 'assistance',
  basicly: 'basically', becuase: 'because', beleive: 'believe', beleived: 'believed', begining: 'beginning',
  beeing: 'being', bizness: 'business', buisness: 'business', calender: 'calendar', catagory: 'category',
  cemetary: 'cemetery', changable: 'changeable', collegue: 'colleague', comming: 'coming', commited: 'committed',
  completly: 'completely', concious: 'conscious', consistant: 'consistent', continous: 'continuous',
  definately: 'definitely', dependant: 'dependent', desparate: 'desperate', diffrent: 'different',
  dissapoint: 'disappoint', dissapear: 'disappear', embarass: 'embarrass', enviroment: 'environment',
  equiptment: 'equipment', existance: 'existence', experiance: 'experience', familar: 'familiar',
  febuary: 'february', finaly: 'finally', flexable: 'flexible', flourescent: 'fluorescent', foriegn: 'foreign',
  freind: 'friend', fufill: 'fulfill', garantee: 'guarantee', gaurd: 'guard', goverment: 'government',
  grammer: 'grammar', happend: 'happened', harrass: 'harass', hieght: 'height', immediatly: 'immediately',
  independant: 'independent', intergrate: 'integrate', knowlege: 'knowledge', liason: 'liaison',
  libary: 'library', lisence: 'license', maintainance: 'maintenance', managable: 'manageable',
  millenium: 'millennium', minature: 'miniature', mispell: 'misspell', neccessary: 'necessary',
  neccesary: 'necessary', noticable: 'noticeable', occassion: 'occasion', occured: 'occurred',
  occuring: 'occurring', occurence: 'occurrence', paralell: 'parallel', peice: 'piece', persistant: 'persistent',
  posession: 'possession', posess: 'possess', practial: 'practical', prefered: 'preferred', priviledge: 'privilege',
  probaly: 'probably', proffesional: 'professional', pronounciation: 'pronunciation', publically: 'publicly',
  quater: 'quarter', questionaire: 'questionnaire', recieve: 'receive', recieved: 'received', reciept: 'receipt',
  recomend: 'recommend', recomended: 'recommended', refered: 'referred', relevent: 'relevant', religous: 'religious',
  remeber: 'remember', responce: 'response', resturant: 'restaurant', rythm: 'rhythm', seperate: 'separate',
  seperated: 'separated', seperately: 'separately', similiar: 'similar', sincerly: 'sincerely', speach: 'speech',
  succesful: 'successful', successfull: 'successful', succesfully: 'successfully', suprise: 'surprise',
  suprised: 'surprised', temperture: 'temperature', tendancy: 'tendency', therefor: 'therefore',
  threshhold: 'threshold', tommorow: 'tomorrow', tommorrow: 'tomorrow', tounge: 'tongue', truely: 'truly',
  unfortunatly: 'unfortunately', untill: 'until', useable: 'usable', vaccum: 'vacuum', vehical: 'vehicle',
  wich: 'which', wierd: 'weird', writting: 'writing', yeild: 'yield', teh: 'the', thier: 'their', adn: 'and',
  alot: 'a lot', becomeing: 'becoming', accross: 'across', appropiate: 'appropriate', availible: 'available',
  belive: 'believe', comitment: 'commitment', developement: 'development', garenteed: 'guaranteed',
  intresting: 'interesting', oppurtunity: 'opportunity', payed: 'paid', personel: 'personnel', proccess: 'process',
  reccomend: 'recommend', succes: 'success', wether: 'whether', withdrawl: 'withdrawal',
};

// Function words whose consecutive duplication is essentially ALWAYS a typo ("the the", "and and").
// Deliberately excludes words that can legitimately double in English ("that that", "had had",
// "it it") to keep zero false positives.
const DOUBLE_WORDS = ['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was', 'for', 'with'];

module.exports = { MISSPELLINGS, DOUBLE_WORDS };
