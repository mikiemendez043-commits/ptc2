const EXAM_TYPES = ["OLT01", "TLT01", "TNT01"];

const QUALIFICATIONS = [
  "Driving NC II",
  "Organic Agriculture Production NC II",
  "Construction Painting NC II",
  "Masonry NC I",
  "Bread and Pastry Production NC II",
  "Agroentrepreneurship NC II",
  "Agroentrepreneurship NC III",
  "Community Nutrition Services NC II"
];

const REQUIRED_ITEM_COUNTS = {
  OLT01: 35,
  TLT01: 35,
  TNT01: 30
};

function getRequiredItemCount(examType) {
  return REQUIRED_ITEM_COUNTS[examType] || 0;
}

function getRating(examType, score) {
  if (examType === 'TNT01') {
    if (score <= 6) return 'Poor';
    if (score <= 12) return 'Fair';
    if (score <= 18) return 'Good';
    if (score <= 24) return 'Very Good';
    return 'Excellent';
  }
  // OLT01 and TLT01 use the same 35-item rating bands.
  if (score <= 5) return 'Very Poor';
  if (score <= 11) return 'Poor';
  if (score <= 17) return 'Fair';
  if (score <= 23) return 'Good';
  if (score <= 29) return 'Very Good';
  return 'Excellent';
}

function getRatingMessage(rating) {
  switch (rating) {
    case 'Excellent':
      return 'Outstanding work. You demonstrated strong subject mastery.';
    case 'Very Good':
      return 'Great performance. Keep studying and you will continue to improve.';
    case 'Good':
      return 'A solid score. Review a few areas and come back even stronger.';
    case 'Fair':
      return 'A fair attempt. Practice more to build confidence and knowledge.';
    case 'Poor':
      return 'A challenging result. Focus on fundamentals and try again after more practice.';
    case 'Very Poor':
      return 'This exam was difficult. Seek review materials and ask your instructor for help.';
    default:
      return 'Your exam is complete. Review the results and reach out if you need support.';
  }
}

module.exports = {
  EXAM_TYPES,
  QUALIFICATIONS,
  REQUIRED_ITEM_COUNTS,
  getRequiredItemCount,
  getRating,
  getRatingMessage
};
