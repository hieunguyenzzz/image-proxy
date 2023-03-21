import fs from 'fs'
import path from 'path'
import axios from 'axios';

export default async function handler(req, res) {
    const {path: imageFile} = req.query;
    const name = imageFile[imageFile.length - 1];

    if (name === 'no_selection' || name === 'undefined') return;
    let filePath = path.resolve('.', 'public/images/', ...imageFile);
    if (fs.existsSync(filePath)) {
        console.log('loading actual file ');
        const imageBuffer = fs.readFileSync(filePath)

        res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
        res.send(imageBuffer);
        return;
    }

    if (imageFile[3].includes('e_trim')) {
        imageFile[3] = 'e_trim';
    }


    filePath = path.resolve('.', 'public/images/', ...imageFile);

    let url = 'https://res.cloudinary.com/' + imageFile.join('/');

    if (!fs.existsSync(filePath)) {

        try {
            // if (imageFile[3].includes('e_trim')) {
            //     console.log('e_trim_ilation');
            //     imageFile[3] = 'e_trim';
            // }

            url = 'https://res.cloudinary.com/' + imageFile.join('/');
            let alternativeUrl = 'https://ik.imagekit.io/tg3wenekj/' + [imageFile[4] ,imageFile[5],imageFile[6],imageFile[7],imageFile[8],imageFile[9]].join('/') + '?tr=t-true';
            if (url.includes('e_trim')) {
                await downloadImage(alternativeUrl, filePath);
                console.log('downloading ' + alternativeUrl)
            } else {
                await downloadImage(url, filePath);
                console.log('downloading ' + url)
            }
            
            
        } catch (err) {
            console.log('can not download ');
            console.log(err);
            //await downloadImage('https://ik.imagekit.io/tg3wenekj/' + [imageFile[4] ,imageFile[5],imageFile[6],imageFile[7],imageFile[8],imageFile[9]].join('/') + '?tr=t-true' ,filePath);
        }

    }

    const imageBuffer = fs.readFileSync(filePath)

    res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
    res.send(imageBuffer)
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
