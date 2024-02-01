import { Notice, base64ToArrayBuffer } from 'obsidian';
import { google, gmail_v1 } from 'googleapis';
import { formatTitle, processBody, incr_filename } from 'src/mailProcess';
import { ObsGMailSettings } from 'src/setting';
import { authorize } from 'src/GOauth';
// @ts-ignore
export function createGmailConnect(client) {
    return google.gmail({
        version: 'v1',
        auth: client
    })
}

const label_options = new Map(
    [
        ["tag", "#{}"],
        ["link", "[[{}]]"]
    ])

const body_options = new Map(
    [
        ["htmlmd", "htmlmd"],
        ["text", "text"],
        ["raw", "raw"]
    ])

export async function fetchMailAction(settings: ObsGMailSettings) {

    if (settings.gc.gmail) {
        await authorize(settings).then(() => {
            fetchMails(settings);
        })
    }
    else {
        new Notice('Gmail: Please Setup first')
    }
}

export async function getMailAccount(gmail: gmail_v1.Gmail) {
    const res = await gmail.users.getProfile({
        userId: 'me'
    });
    const mail_address = res.data.emailAddress;
    return mail_address || "";
}

export async function listLabels(account: string, gmail: gmail_v1.Gmail) {

    const res = await gmail.users.labels.list({
        userId: account
    });
    const labels = res.data.labels;
    if (!labels || labels.length === 0) {
        console.log('No labels found.');
        return;
    }
    let label_list = Array<Array<string>>();
    labels.forEach((label) => {
        label_list.push([String(label.name), String(label.id)])
    });
    return label_list;
}

async function getLabelIDbyName(name: string, gmail: gmail_v1.Gmail) {
    const res = await gmail.users.labels.list({
        userId: 'me'
    });
    const labels = res.data.labels || [];
    let result_id = ""
    labels.forEach((label) => {
        if (label.name === name) { result_id = label.id || "" }
    });
    return result_id;
}

function fillTemplate(template: string, mail: Map<string, string>) {
    const string = template.replace(
        /\${\w+}/g,
        function (all) {
            return mail.get(all) || '';
        });
    return string
}

function getFields(ary: Array<{ name: string, value: string }>) {
    const m = new Map<string, string>()
    ary.forEach((item) => {
        m.set("${" + item.name + "}", item.value)
    })
    return m
}

function getLabelName(id: string, labels: Array<Array<string>>) {
    for (let i = 0; i < labels.length; i++)
        if (id == labels[i][1])
            return labels[i][0]
    return ""
}
function formatDate(iso_date: string) {
    const d = new Date(iso_date);
    return d.toISOString().split('T')[0]
}
async function obtainTemplate(template_path: string) {
    let template = "${Body}" // default template
    if (template_path) {
        template = await this.app.vault.readRaw(template_path)
    }
    // Obtain label option
    const label_match = template.match(/\$\{Labels\|*(.*)\}/) || []
    const label_format = label_options.get(label_match[1]) || "#{}"
    template = template.replace(/\$\{Labels.*\}/, "${Labels}")
    // Obtain body format
    const body_match = template.match(/\$\{Body\|*(.*)\}/) || []
    const body_format = body_options.get(body_match[1]) || "htmlmd"
    template = template.replace(/\$\{Body.*\}/, "${Body}")
    return { template: template, label_format: label_format, body_format: body_format }
}

function cleanFilename(filename: string) {
    return filename.replace(/[\\/:"*?<>|]+/g, '_')
}

async function getAttachment(gmail:gmail_v1.Gmail, account: string, message_id: string, attachment_id: string) {
    const res = await gmail.users.messages.attachments.get({
        userId: account,
        messageId: message_id,
        id: attachment_id
    });
    return res
}

const b64toBlob = (b64Data:string, contentType='', sliceSize=512) => {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];
  
    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
  
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
  
      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }
  
    const blob = new Blob(byteArrays, {type: contentType});
    return blob;
  }

async function getAttachments(gmail:gmail_v1.Gmail, account:string, msgId: string, parts:any, folder:string){
    const files = Array<string>();
    for(let i = 0; i < parts.length; i++){
        const part = parts[i];
        const filename = part.filename
        const attach_id = part.body.attachmentId

		if(!filename || !attach_id) {
			console.debug(msgId, `Part ${i} has no filename or attachmentId, skipping...`)
			continue
		}

        const ares = await getAttachment(gmail, account, msgId, attach_id)
        const red = ares.data?.data?.replace(/-/g, '+').replace(/_/g, '/') || ""
        const init_name = filename
        const final_name = await incr_filename(init_name, folder)
        await this.app.vault.createBinary(final_name, base64ToArrayBuffer(red))
        files.push(final_name)
    }
    return files
}

function flatten_parts(dst:any, parts:any){
    if(parts.length == 2 && parts[0].mimeType =='text/plain' && parts[1].mimeType =='text/html'){
        dst.mtxt = parts[0].body
        dst.mhtml = parts[1].body
        for(let i = 2; i < parts.length; i++){
            dst.assets.push(parts[i])
        }
        return dst
    }
    else {
        for(let i = 0; i < parts.length;i++){
            if(parts[i].mimeType=='multipart/related'||parts[i].mimeType=="multipart/alternative" || parts[i].mimeType=="multipart/mixed")
                flatten_parts(dst, parts[i].parts)
            else
                dst.assets.push(parts[i])
        }
    }
}

interface mail_obj{
    assets: Array<any>,
    mhtml: string,
    mtxt: string
}

async function saveMail(settings: ObsGMailSettings, id: string) {
    const note = await obtainTemplate(settings.template)
    const noteName_template = settings.noteName
    const gmail = settings.gc.gmail
    const account = settings.mail_account
    const folder = settings.mail_folder
    const res = await gmail.users.threads.get({
        userId: account,
        id: id,
        format: 'full'
    });
    const title_candidates = ((res.data.messages || [])[0].payload?.headers || [])
    const labelIDs = (res.data.messages || [])[0].labelIds;
    const labels = labelIDs.map((labelID: string) => getLabelName(labelID, settings.labels))
    const fields = getFields(title_candidates)
    fields.set('${Date}', formatDate(fields.get('${Date}') || ""))
    fields.set('${Labels}', labels.map((label: string) => note.label_format.replace(/\{\}/, label)).join(', '))
    let title = formatTitle(fields.get('${Subject}') || "")
    // Fetch the last mail in the threads
    const payload = res.data.messages.pop().payload
    const dst:mail_obj = {assets: Array<any>(), mhtml:"", mtxt:""}
    flatten_parts(dst, payload.parts)
    if(dst.mhtml=="" && dst.mtxt==""){
        dst.mhtml = dst.assets.pop().body.data;
        dst.mtxt = dst.mhtml;
    }
    console.log("DST:")
    console.log(payload)
    console.log(dst)
    const body = await processBody([dst.mtxt, dst.mhtml], note.body_format)
    fields.set('${Body}', body)
    fields.set('${Link}', `https://mail.google.com/mail/#all/${id}`)
    const noteName = cleanFilename(fillTemplate(noteName_template, fields))
    const finalNoteName = await incr_filename(noteName+`.md`, folder)
    if(settings.toFetchAttachment && (dst.assets.length > 0)){
        const msgID = payload.headers[2].value
        await mkdirP(settings.attachment_folder);
        const files = await getAttachments(gmail, account, 
            msgID, dst.assets, settings.attachment_folder);
        fields.set('${Attachment}', files.map(f=>`![[${f}]]`).join('\n'))
    }
    else
        fields.set('${Attachment}', "")
    const content = fillTemplate(note.template, fields)
    await this.app.vault.create(finalNoteName, content)
}

async function fetchMailList(account: string, labelID: string, gmail: gmail_v1.Gmail) {
    const res = await gmail.users.threads.list({
        userId: account,
        labelIds: [labelID],
        maxResults: 100
    });
    return res.data.threads;
}

async function updateLabel(account: string, from_labelID: string, to_labelID: string, id: string, gmail: gmail_v1.Gmail) {
    const res = await gmail.users.threads.modify({
        userId: account,
        id: id,
        requestBody: {
            addLabelIds: [to_labelID],
            removeLabelIds: [from_labelID]
        },
    });

}

async function destroyMail(account: string, id: string, gmail: gmail_v1.Gmail) {
    const res = await gmail.users.threads.trash({
        userId: account,
        id: id,
    });

}

async function mkdirP(path: string) {
    const isExist = await this.app.vault.exists(path)
    if (!isExist) {
        this.app.vault.createFolder(path)
    }
}

async function fetchMails(settings: ObsGMailSettings) {
    const account = settings.mail_account;
    const fromID = settings.from_label;
    const toID = settings.to_label;
    const base_folder = settings.mail_folder;
    const amount = settings.fetch_amount;
    const gmail = settings.gc.gmail;

    new Notice('Gmail: Fetch starting');
    await mkdirP(base_folder)
    const threads = await fetchMailList(account, fromID, gmail) || []
    if (threads.length == 0) {
        new Notice(`Gmail: Your inbox is up to date`);
        return
    }
    const len = Math.min(threads.length, amount)
    for (let i = 0; i < len; i++) {
        if (i % 5 == 0 && i > 0)
            new Notice(`Gmail: ${(i / len * 100).toFixed(0)}% fetched`);
        const id = threads[i].id || ""
        await saveMail(settings, id);
        await updateLabel(account, fromID, toID, id, gmail);
        if (settings.destroy_on_fetch) {
            await destroyMail(account, id, gmail)
        }
    }
    new Notice(`Gmail: ${len} mails fetched.`);
    if (threads.length > amount)
        new Notice(`Gmail: There are ${threads.length - amount} mails not fetched.`);
    else
        new Notice(`Gmail: Your inbox is up to date`);
}
