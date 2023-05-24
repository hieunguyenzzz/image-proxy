import fs from 'fs'
import path from 'path'
import axios from 'axios';

export default async function handler(req, res) {
    const {path: imageFile} = req.query;
    let cloudinaryAttributes = [];
    let imagekitAttributes = [];
    const name = imageFile[imageFile.length - 1];

    if (name === 'no_selection' || name === 'undefined') return;
    let filePath = path.resolve('.', 'public/images/', ...imageFile);
    if (fs.existsSync(filePath)) {
        const imageBuffer = fs.readFileSync(filePath)

        res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
        res.send(imageBuffer);
        return;
    }

    if (imageFile[4].includes('media') || imageFile[4].includes('mobelaris') || imageFile[4].includes('uploads')  || imageFile[4].includes('wp-content') ) {
        if (imageFile[3].includes('e_trim')) {
            imagekitAttributes.push('t-true');
            cloudinaryAttributes.push('e_trim');
        }
        if (imageFile[3].includes('w_')) {
            const url = imageFile[3];
            const match = url.match(/w_(\d+)/);
            if (match) {
                const number = parseInt(match[1], 10);
                cloudinaryAttributes.push('w_' + number);
                imagekitAttributes.push('w-' + number);
            }
        }
        if (cloudinaryAttributes.length > 0) {
            imageFile[3] = cloudinaryAttributes.join(',');
        }
    }


    filePath = path.resolve('.', 'public/images/', ...imageFile);

    let url = 'https://res.cloudinary.com/' + imageFile.join('/');

    if (!fs.existsSync(filePath)) {

        try {
            // if (imageFile[3].includes('e_trim')) {
            //     console.log('e_trim_ilation');
            //     imageFile[3] = 'e_trim';
            // }

            // url = 'https://res.cloudinary.com/' + imageFile.join('/').replace('mobelaris/','');
            url = 'https://res.cloudinary.com/' + imageFile.join('/');
            console.log(imageFile[4]);
            if (imageFile[4].includes('uploads')) {
                let alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + [imageFile[4] ,imageFile[5]].join('/') + '?tr=' + imagekitAttributes.join(',') ;
                console.log(alternativeUrl);
                await downloadImage(alternativeUrl, filePath);
                console.log('downloading ' + alternativeUrl)
            } else if (imageFile[4].includes('wp-content')) {
                let alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + ['wpcontent' ,imageFile[5], imageFile[6], imageFile[7], imageFile[8]].join('/') + '?tr=' + imagekitAttributes.join(',');
                await downloadImage(alternativeUrl, filePath);
                console.log('downloading ' + alternativeUrl)
            } else if (imageFile[4].includes('media'))  {
                let alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + [imageFile[4] ,imageFile[5],imageFile[6],imageFile[7],imageFile[8],imageFile[9]].join('/') + '?tr=' + imagekitAttributes.join(',');
                
                // await downloadImage(url, filePath);
                await downloadImage(alternativeUrl.replace('/mobelaris/', ''), filePath);
                
                console.log('downloading ' + alternativeUrl.replace('/mobelaris/', ''));
            } else {
                await downloadImage(url, filePath);
                console.log('downloading ' + url);
            }
            
            
        } catch (err) {
            console.log('can not download ');
            console.log(err);
            //await downloadImage('https://ik.imagekit.io/tg3wenekj/' + [imageFile[4] ,imageFile[5],imageFile[6],imageFile[7],imageFile[8],imageFile[9]].join('/') + '?tr=t-true' ,filePath);
        }

    }
    try {
        const imageBuffer = fs.readFileSync(filePath)

        res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
        res.send(imageBuffer)
    } catch(err) {
        console.log('file not exist ' + filePath);
    }
    
}

const downloadImage = async (url, filePath) => {
    const response = await axios({
        url,
        responseType: 'stream',
    });

    const directoryPath = path.dirname(filePath);
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, {recursive: true});
    }

    return new Promise((resolve, reject) => {
        const stream = response.data.pipe(fs.createWriteStream(filePath));
        stream.on('finish', () => resolve());
        stream.on('error', e => reject(e));
    });
};

const formatUrl = (url) => {
    // get the width
    let uri = url.replace(/http.+?product/, '');


    const match = url.match(/w_(\d+)/);
    if (match) {
        const wValue = match[1];    
    }
}
