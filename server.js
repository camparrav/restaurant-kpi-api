{
  "filename": "@{items('For_each')?['name']}",
  "base64PDF": "@{base64(body('Get_attachment_(V2)')?['contentBytes'])}",
  "emailSubject": "@{triggerOutputs()?['body/subject']}",
  "emailFrom": "@{triggerOutputs()?['body/from']}",
  "emailDate": "@{triggerOutputs()?['body/receivedDateTime']}"
}
